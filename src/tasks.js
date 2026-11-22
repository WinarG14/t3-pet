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
    this.dismissed = new Map();  // thread key -> runId the user dismissed in the pet
    this.last = null;
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
    };
  }

  async snapshot() {
    const s = this.getSettings();
    if (s.dataSource === 'database' || !this.client.serverRunning()) return this.fallback(this.client.serverRunning() ? null : 'T3 is not running.');
    let envs;
    try {
      envs = await this.environments();
    } catch (e) {
      return this.fallback(e.message);
    }
    const local = { id: envs.localId, label: os.hostname(), isLocal: true, status: 'reachable' };
    const environments = [local, ...envs.links.map(l => ({ ...l, isLocal: false }))];

    const lists = [];
    try {
      lists.push({ env: local, threads: await this.listThreads(local.id, true) });
    } catch (e) {
      return this.fallback(e.message);
    }
    const remoteEvery = Math.max(5e3, s.remotePollMs || 10e3);
    await Promise.all(envs.links.map(async link => {
      const env = { ...link, isLocal: false };
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
        if (c) lists.push({ env, threads: c.threads, stale: true });
      }
    }));

    const since = Date.now() - (s.lookbackHours || 72) * 3600e3;
    const visits = s.preciseLocalUnread === false ? null : watcher.readLocalVisits();
    const candidates = [];
    for (const { env, threads } of lists) {
      for (const raw of threads) {
        const t = this.normalize(raw, env);
        if (t.child || t.snoozed) continue;
        const active = ACTIVE.has(t.status) || t.status === 'waiting';
        if (t.settled && !active) continue;
        if (!active && Date.parse(t.updatedAt) < since) continue;
        candidates.push(t);
      }
    }

    // Read the threads that matter, newest first, a few per poll. Never read child or delegated threads:
    // T3 marks a child's final result as delivered when it is read.
    let budget = MAX_READS_PER_POLL;
    const ordered = [...candidates].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
      const visitedAt = t.isLocal && visits ? (visits.get(t.id) || '') : undefined;
      const { state, detail } = deriveState(t, { ...r, visitedAt, dismissedRunId: this.dismissed.get(t.key) });
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
    const counts = {};
    for (const t of out) counts[t.state] = (counts[t.state] || 0) + 1;
    this.last = {
      ok: true, source: 'mcp', serverAlive: true, threads: out, counts, at: new Date().toISOString(),
      environments: environments.map(e => ({ id: e.id, label: e.label, isLocal: e.isLocal, status: e.error ? 'error' : e.status, error: e.error || null })),
    };
    return this.last;
  }

  fallback(reason) {
    const snap = watcher.readSnapshot({ dbPath: this.getSettings().t3DbPath, lookbackHours: this.getSettings().lookbackHours });
    const envId = (() => { try { return require('fs').readFileSync(require('path').join(watcher.T3_DIR, 'environment-id'), 'utf8').trim(); } catch { return 'local'; } })();
    for (const t of snap.threads || []) Object.assign(t, { key: `${envId}/${t.id}`, envId, envLabel: os.hostname(), isLocal: true });
    snap.source = 'database';
    snap.notice = reason ? `Showing this computer only (${reason})` : 'Showing this computer only';
    snap.environments = [{ id: envId, label: os.hostname(), isLocal: true, status: 'reachable' }];
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
      this.dismissed.set(key, t.runId);
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
