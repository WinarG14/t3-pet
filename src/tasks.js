// Builds the pet's task snapshot from T3's MCP tools: this machine plus every linked environment.
// Falls back to reading this machine's T3 database when the MCP route is unavailable.
const os = require('os');
const watcher = require('./watcher');

const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running']);
const UNREAD_WINDOW_MS = 30 * 60e3; // T3 marks a finished thread read on its own 30 minutes after it completes
const READ_TTL_MS = 15e3;           // refresh a running thread's last message at most this often
const MAX_READS_PER_POLL = 6;

const REQUEST_TYPES = new Set(['approval_request', 'user_input_request', 'secret_request', 'link_request']);

/**
 * Pure state rule, exported for tests.
 * @param {object} t   normalized thread (status, blocked, delegated, completedAt, runId, isLocal, id)
 * @param {object} x   extra: { pendingRequestCount, requestText, lastText, visitedAt, dismissedRunId, now }
 */
function deriveState(t, x = {}) {
  const now = x.now || Date.now();
  if (t.status === 'waiting') {
    if (t.blocked) return { state: 'running', detail: 'Waiting for a sub-task to finish' };
    if ((x.pendingRequestCount || 0) > 0) return { state: 'waiting', detail: x.requestText || 'Needs your approval or answer' };
    return { state: 'running', detail: x.lastText ? watcher.clip(watcher.lastParagraph(x.lastText), 140) : 'Waiting' };
  }
  if (ACTIVE.has(t.status)) {
    return { state: 'running', detail: x.lastText ? watcher.clip(watcher.lastParagraph(x.lastText), 140) : '' };
  }
  const finished = ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'].includes(t.status);
  if (!finished) return { state: 'idle', detail: x.lastText ? watcher.needLine(x.lastText) : '' };
  const doneAt = t.completedAt || t.updatedAt;
  let unseen;
  if (x.dismissedRunId && x.dismissedRunId === t.runId) unseen = false;
  else if (x.visitedAt !== undefined) unseen = !x.visitedAt || x.visitedAt < doneAt;
  else unseen = Date.parse(doneAt) > now - UNREAD_WINDOW_MS;
  if (unseen && Date.parse(doneAt) < now - 24 * 3600e3) unseen = false;
  const detail = x.lastText ? watcher.needLine(x.lastText) : '';
  if (!unseen) return { state: 'idle', detail };
  if (t.status === 'failed') return { state: 'failed', detail: detail || 'The run failed.' };
  if (t.status !== 'completed') return { state: 'stopped', detail };
  if (x.lastText && watcher.looksLikeQuestion(x.lastText)) return { state: 'needs-reply', detail };
  return { state: 'done', detail };
}

/** Turn a T3 client error into a setup problem the panel can explain and offer a fix for. */
function problemFrom(e) {
  if (e && e.code === 'no_cli') return { code: 'no-cli', text: e.message };
  if (e && e.code === 'unreachable') return { code: 'unreachable', text: 'T3 Code does not answer right now.' };
  if (e && e.code === 'unauthorized') return { code: 'signin', text: 'T3 refused the pet\u2019s read-only sign-in.' };
  return { code: 'error', text: `T3 Pet can't read T3 (${(e && e.message) || 'unknown error'}).` };
}

/** Muted project and schedule keys ("<environmentId>/<id>") from settings. */
function mutedSets(s) {
  const m = (s && s.muted) || {};
  return { projects: new Set(m.projects || []), schedules: new Set(m.schedules || []) };
}

/** Counts per state, without muted threads: they don't move the pet, the badge or the chips. */
function countStates(threads) {
  const counts = {};
  for (const t of threads || []) if (!t.muted) counts[t.state] = (counts[t.state] || 0) + 1;
  return counts;
}

class TaskSource {
  /**
   * @param {object} o
   * @param {import('./t3client').T3Client} o.client
   * @param {() => object} o.getSettings
   * @param {(line: string) => void} [o.log]
   */
  constructor({ client, getSettings, log = () => {} }) {
    this.client = client;
    this.getSettings = getSettings;
    this.log = log;
    this.envs = null;
    this.envsAt = 0;
    this.remote = new Map();     // envId -> { at, threads, error }
    this.projects = new Map();   // envKey -> { at, names: Map }
    this.reads = new Map();      // thread key -> cached read
    this.dismissed = new Map();  // thread key -> 'runId|status' hidden in the pet until that changes
    this.last = null;
    this.firstSeen = new Map(); // envId -> when the pet first listed that machine's threads
    this.schedules = new Map(); // envKey -> { at, tasks } (T3 scheduled tasks, for muting)
    this.scheduleOf = new Map(); // thread key -> { scheduleKey, scheduleTitle }: last match, for offline use
  }

  async environments() {
    if (this.envs && Date.now() - this.envsAt < 60e3) return this.envs;
    const r = await this.client.call('t3_environment_links', {});
    this.envs = {
      localId: r.environmentId,
      links: (r.links || []).map(l => ({ id: l.environmentId, label: l.label || l.environmentId.slice(0, 8), status: l.status, lastError: l.lastError })),
    };
    this.envsAt = Date.now();
    return this.envs;
  }

  async projectNames(envId, isLocal) {
    const k = isLocal ? 'local' : envId;
    const c = this.projects.get(k);
    if (c && Date.now() - c.at < 5 * 60e3) return c.names;
    const names = new Map();
    try {
      const r = await this.client.call('t3_project_list', { ...(isLocal ? {} : { environmentId: envId }), limit: 100 });
      for (const p of r.projects || []) names.set(p.projectId || p.id, p.title || p.name || '');
    } catch (e) {
      if (c) return c.names;
    }
    this.projects.set(k, { at: Date.now(), names });
    return names;
  }

  /** T3's scheduled tasks on one machine (cached 5 minutes). Used to mute automation threads. */
  async scheduleList(envId, isLocal) {
    const k = isLocal ? 'local' : envId;
    const c = this.schedules.get(k);
    if (c && Date.now() - c.at < 5 * 60e3) return c.tasks;
    let tasks = c ? c.tasks : [];
    try {
      const r = await this.client.call('list_scheduled_tasks', isLocal ? {} : { environmentId: envId });
      tasks = r.tasks || [];
    } catch (e) {
      this.log(`Could not list scheduled tasks: ${e.message}`);
    }
    this.schedules.set(k, { at: Date.now(), tasks });
    return tasks;
  }

  async listThreads(envId, isLocal) {
    const r = await this.client.call('t3_thread_list', { ...(isLocal ? {} : { environmentId: envId }), allProjects: true, includeSubagents: false, limit: 40 });
    return r.threads || [];
  }

  /** Latest assistant text (and pending request for waiting threads), cached and throttled. */
  async readThread(t) {
    const key = t.key;
    const c = this.reads.get(key);
    const fresh = c && c.runId === t.runId && c.status === t.status && (
      ACTIVE.has(t.status) ? Date.now() - c.at < READ_TTL_MS : c.updatedAt === t.updatedAt || !ACTIVE.has(t.status)
    );
    if (fresh) return c;
    const view = t.status === 'waiting' ? 'activity' : 'messages';
    const r = await this.client.call('t3_thread_read', {
      ...(t.isLocal ? {} : { environmentId: t.envId }),
      threadId: t.id, view, beforePosition: 1e9, limit: view === 'activity' ? 8 : 4, maxCharsPerItem: 1500,
    });
    const items = r.items || [];
    const lastAssistant = [...items].reverse().find(i => i.type === 'assistant_message' && i.text);
    const request = [...items].reverse().find(i => REQUEST_TYPES.has(i.type) && !['completed', 'cancelled', 'failed'].includes(i.status));
    const run = (r.recentRuns || [])[0];
    const out = {
      runId: t.runId, status: t.status, updatedAt: t.updatedAt, at: Date.now(),
      lastText: lastAssistant ? lastAssistant.text : (c && c.lastText) || '',
      pendingRequestCount: r.thread ? r.thread.pendingRequestCount || 0 : 0,
      requestText: request ? watcher.clip(request.title || request.text || '', 160) : '',
      completedAt: run && run.completedAt,
    };
    this.reads.set(key, out);
    return out;
  }

  normalize(raw, env) {
    return {
      key: `${env.id}/${raw.threadId}`,
      id: raw.threadId,
      envId: env.id,
      envLabel: env.label,
      isLocal: env.isLocal,
      title: raw.title || 'Untitled thread',
      projectId: raw.projectId,
      status: raw.status,
      runId: raw.latestRunId,
      updatedAt: raw.updatedAt,
      settled: !!raw.settled,
      snoozed: !!raw.snoozed,
      pinned: !!raw.pinned,
      blocked: !!raw.blockedOnThreadWait || (raw.pendingBackgroundTasks || []).length > 0,
      child: !!raw.parentThreadId,
      delegated: !!raw.delegatedFrom,
      byUser: raw.createdBy === 'user',
    };
  }

  async snapshot() {
    const s = this.getSettings();
    if (s.dataSource === 'database') return this.fallback(null);
    if (!this.client.serverRunning()) {
      const fs = require('fs');
      if (fs.existsSync(this.client.userdata)) return this.fallback({ code: 'not-running', text: 'T3 Code is not running, so linked machines are hidden.' });
      const app = this.getSettings().t3App;
      return app && fs.existsSync(app)
        ? this.fallback({ code: 'not-started', text: 'T3 Code is installed but has not run yet. Open it once; T3 Pet then connects by itself.' })
        : this.fallback({ code: 'not-installed', text: 'T3 Code is not set up on this computer yet. Install it and open it once; T3 Pet then connects by itself.' });
    }
    let envs;
    try {
      envs = await this.environments();
    } catch (e) {
      return this.fallback(problemFrom(e));
    }
    const local = { id: envs.localId, label: os.hostname(), isLocal: true, status: 'reachable' };
    const environments = [local, ...envs.links.map(l => ({ ...l, isLocal: false }))];

    const lists = [];
    try {
      lists.push({ env: local, threads: await this.listThreads(local.id, true) });
    } catch (e) {
      return this.fallback(problemFrom(e));
    }
    const remoteEvery = Math.max(5e3, s.remotePollMs || 10e3);
    // Record errors on the same objects that the snapshot publishes, so Settings and the notification
    // logic both see an unreachable machine as unreachable.
    await Promise.all(environments.slice(1).map(async env => {
      const link = env;
      const c = this.remote.get(link.id);
      if (link.status !== 'reachable') {
        env.error = link.lastError || link.status;
        if (c) lists.push({ env, threads: c.threads, stale: true });
        return;
      }
      if (c && Date.now() - c.at < remoteEvery) return lists.push({ env, threads: c.threads });
      try {
        const threads = await this.listThreads(link.id, false);
        this.remote.set(link.id, { at: Date.now(), threads });
        lists.push({ env, threads });
      } catch (e) {
        env.error = e.message;
        // A failed request on a reachable link: keep its threads and count it as still seen, so real
        // changes after the hiccup still alert. (An expired link above does not count as seen.)
        if (c) { env.cached = true; lists.push({ env, threads: c.threads, stale: true }); }
      }
    }));

    const since = Date.now() - (s.lookbackHours || 72) * 3600e3;
    const visits = s.preciseLocalUnread === false ? null : watcher.readLocalVisits();
    const candidates = [];
    for (const { env, threads } of lists) {
      for (const raw of threads) {
        if (!this.firstSeen.has(env.id)) this.firstSeen.set(env.id, Date.now());
        const t = this.normalize(raw, env);
        if (t.child || t.snoozed) continue;
        const active = ACTIVE.has(t.status) || t.status === 'waiting';
        if (t.settled && !active) continue;
        if (!active && Date.parse(t.updatedAt) < since) continue;
        candidates.push(t);
      }
    }

    // Schedules and mutes come first, so muted threads can't use up the detail reads below.
    // A machine that is down keeps its last known schedules while its cached threads still show.
    const scheds = new Map();
    for (const env of environments) {
      const k = env.isLocal ? 'local' : env.id;
      if (env.isLocal || env.status === 'reachable') scheds.set(env.id, await this.scheduleList(env.id, env.isLocal));
      else if (this.schedules.has(k)) scheds.set(env.id, this.schedules.get(k).tasks);
    }
    const muted = mutedSets(s);
    for (const t of candidates) {
      const list = scheds.get(t.envId) || [];
      // Its schedule: the schedule's own (bound) thread first; else, for a schedule that starts a new thread
      // per run, a thread an agent made in the schedule's project with the schedule's title (never one the
      // user started by hand).
      const sc = list.find(x => x.boundThreadId === t.id)
        || (!t.byUser ? list.find(x => !x.boundThreadId && x.projectId === t.projectId && x.title === t.title) : null);
      const known = sc ? { scheduleKey: `${t.envId}/${sc.scheduledTaskId}`, scheduleTitle: sc.title || 'Scheduled task' } : (scheds.has(t.envId) ? null : this.scheduleOf.get(t.key));
      if (known) { Object.assign(t, known); this.scheduleOf.set(t.key, known); } else if (scheds.has(t.envId)) this.scheduleOf.delete(t.key);
      t.projectKey = `${t.envId}/${t.projectId}`;
      t.mutedBy = t.scheduleKey && muted.schedules.has(t.scheduleKey) ? 'schedule' : muted.projects.has(t.projectKey) ? 'project' : null;
      t.muted = !!t.mutedBy;
    }

    // Read the threads that matter, unmuted and newest first, a few per poll. Never read child or delegated
    // threads: T3 marks a child's final result as delivered when it is read.
    let budget = MAX_READS_PER_POLL;
    const ordered = [...candidates].sort((a, b) => (a.muted - b.muted) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const t of ordered) {
      if (t.delegated || budget <= 0) continue;
      const c = this.reads.get(t.key);
      const needs = !c || c.runId !== t.runId || c.status !== t.status || (ACTIVE.has(t.status) && Date.now() - c.at > READ_TTL_MS) || (t.status === 'waiting' && c.updatedAt !== t.updatedAt);
      if (!needs) continue;
      budget--;
      try { await this.readThread(t); } catch (e) { this.log(`Could not read "${t.title}": ${e.message}`); }
    }

    const names = new Map();
    for (const env of environments) {
      if (env.isLocal || env.status === 'reachable') names.set(env.id, await this.projectNames(env.id, env.isLocal).catch(() => new Map()));
    }
    const out = [];
    for (const t of candidates) {
      const r = this.reads.get(t.key) || {};
      if (r.completedAt && r.runId === t.runId) t.completedAt = r.completedAt;
      // Not read yet: its state (for example "waiting" or "needs a reply") is still a guess, so the
      // first read must not count as a change worth a notification.
      // Only for threads that last changed before the pet first saw their machine: new activity alerts.
      t.provisional = !t.delegated && !this.reads.has(t.key) && Date.parse(t.updatedAt) < (this.firstSeen.get(t.envId) || 0);
      const visitedAt = t.isLocal && visits ? (visits.get(t.id) || '') : undefined;
      let { state, detail } = deriveState(t, { ...r, visitedAt });
      // Hidden in the pet: stays quiet until the thread starts a new run or changes status.
      if (this.dismissed.get(t.key) === `${t.runId}|${t.status}`) state = 'idle';
      out.push({
        ...t,
        state,
        detail,
        project: (names.get(t.envId) || new Map()).get(t.projectId) || '',
        completedAt: t.completedAt || null,
      });
    }
    const rank = { waiting: 0, 'needs-reply': 1, failed: 2, running: 3, stale: 4, done: 5, stopped: 6, idle: 7 };
    out.sort((a, b) => (rank[a.state] - rank[b.state]) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // Lists for Settings > Muted: every schedule, and every project that has recent threads or a schedule.
    const envLabel = id => (environments.find(e => e.id === id) || {}).label || id;
    const schedules = [];
    const projects = new Map();
    for (const [envId, list] of scheds) {
      for (const x of list) {
        const project = (names.get(envId) || new Map()).get(x.projectId) || '';
        schedules.push({ key: `${envId}/${x.scheduledTaskId}`, title: x.title || 'Scheduled task', everyMs: x.schedule && x.schedule.everyMs, enabled: x.enabled !== false, project, envLabel: envLabel(envId) });
        if (x.projectId) projects.set(`${envId}/${x.projectId}`, { key: `${envId}/${x.projectId}`, name: project || 'Untitled project', envLabel: envLabel(envId) });
      }
    }
    for (const t of out) if (t.projectId) projects.set(t.projectKey, { key: t.projectKey, name: t.project || 'Untitled project', envLabel: t.envLabel });
    this.last = {
      ok: true, source: 'mcp', serverAlive: true, threads: out, counts: countStates(out), at: new Date().toISOString(),
      schedules, projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
      environments: environments.map(e => ({ id: e.id, label: e.label, isLocal: e.isLocal, status: e.error ? 'error' : e.status, error: e.error || null, cached: !!e.cached })),
    };
    return this.last;
  }

  /** "Check again": ask every linked machine on the next poll instead of waiting for its interval. */
  refreshRemotes() {
    for (const c of this.remote.values()) c.at = 0;
    this.envsAt = 0; // also ask T3 again for its list of linked machines (new or recovered links)
  }

  /** This computer's T3 database only. `problem` ({ code, text }) says why, or null when the user chose it. */
  fallback(problem) {
    const snap = watcher.readSnapshot({ dbPath: this.getSettings().t3DbPath, lookbackHours: this.getSettings().lookbackHours });
    const envId = (() => { try { return require('fs').readFileSync(require('path').join(watcher.T3_DIR, 'environment-id'), 'utf8').trim(); } catch { return 'local'; } })();
    for (const t of snap.threads || []) Object.assign(t, { key: `${envId}/${t.id}`, envId, envLabel: os.hostname(), isLocal: true });
    const muted = mutedSets(this.getSettings());
    for (const t of snap.threads || []) {
      t.projectKey = `${envId}/${t.projectId}`;
      Object.assign(t, this.scheduleOf.get(`${envId}/${t.id}`) || {}); // schedule matches seen while T3 ran
      t.mutedBy = t.scheduleKey && muted.schedules.has(t.scheduleKey) ? 'schedule' : muted.projects.has(t.projectKey) ? 'project' : null;
      t.muted = !!t.mutedBy;
    }
    if (snap.ok) snap.counts = countStates(snap.threads);
    snap.source = 'database';
    snap.notice = problem ? `${problem.text} Showing this computer's threads only.` : 'Showing this computer only';
    snap.problem = problem || null;
    const quiet = problem && ['not-installed', 'not-started'].includes(problem.code); // no database yet is expected
    snap.environments = [{ id: envId, label: os.hostname(), isLocal: true, ...(snap.ok || quiet ? { status: 'reachable' } : { status: 'error', error: snap.error }) }];
    this.last = snap;
    return snap;
  }

  /** Thread actions. Allowed: settle, unsettle, mark_unread, snooze, pin, unpin, dismiss. */
  async act(key, action) {
    const ALLOWED = ['settle', 'unsettle', 'mark_unread', 'snooze', 'pin', 'unpin', 'dismiss'];
    if (!ALLOWED.includes(action)) throw new Error('Unknown action');
    const t = this.last && this.last.threads.find(x => x.key === key);
    if (!t) throw new Error('That thread is no longer listed.');
    if (action === 'dismiss') {
      this.dismissed.set(key, `${t.runId}|${t.status}`);
      return { ok: true };
    }
    const args = { threadId: t.id, action, ...(t.isLocal ? {} : { environmentId: t.envId }) };
    if (action === 'snooze') args.snoozedUntil = new Date(Date.now() + 3600e3).toISOString();
    try {
      await this.client.call('t3_thread_organize', args, 'actions');
    } catch (e) {
      if (/no completed run/i.test(e.message)) e.message = "This thread hasn't finished a run yet, so it can't be marked unread or settled.";
      else if (/escalation|above this caller/i.test(e.message)) e.message = 'T3 refused: the pet’s sign-in has a lower access level than this thread. Turn thread actions off and on again in Settings.';
      throw e;
    }
    if (action === 'mark_unread') this.dismissed.delete(key);
    if (this.remote.has(t.envId)) this.remote.get(t.envId).at = 0; // refresh that machine on the next poll
    return { ok: true };
  }
}

module.exports = { TaskSource, deriveState };
