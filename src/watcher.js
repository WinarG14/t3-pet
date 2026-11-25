// Reads T3 Code's local state database (read-only) and turns it into a task snapshot.
// T3 does not document this database. Every query here is defensive: unknown values fall back to "idle".
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const T3_DIR = path.join(process.env.T3CODE_HOME || path.join(os.homedir(), '.t3'), 'userdata');
const DEFAULT_DB = path.join(T3_DIR, 'statev2.sqlite');
const RUNTIME_FILE = path.join(T3_DIR, 'server-runtime.json');

// Active run statuses, from T3's own index: runs_recovery_idx WHERE status IN ('queued','preparing','starting','running','waiting').
const RUN_ACTIVE = new Set(['queued', 'preparing', 'starting', 'running', 'waiting', 'pending', 'requested', 'in_progress']);
const REQUEST_DONE = new Set(['resolved', 'cancelled', 'canceled', 'expired', 'failed', 'declined', 'denied', 'superseded', 'timed_out', 'completed']);
const ITEM_DONE = new Set(['completed', 'cancelled', 'canceled', 'failed', 'expired', 'resolved']);

function t3ServerAlive() {
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (!rt.pid) return true;
    process.kill(rt.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // process exists but is not ours
  }
}

const QUESTION_HINTS = /\b(should i|do you want|want me to|would you like|shall i|which (one|option)|can you confirm|please confirm|let me know|your call|approve)\b/i;

function lastParagraph(text) {
  const parts = String(text || '').trim().split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function stripMd(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s, n) {
  s = stripMd(s);
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Pick the sentence a user most needs to see: the last question, else the last paragraph's start.
// A real question: ends with "?" and has at least three words (ignores "??" in git output etc.).
function isQuestionSentence(s) {
  return /[A-Za-z0-9)"'\]]\?\s*$/.test(s) && (s.match(/[A-Za-z]{2,}/g) || []).length >= 3;
}

function sentencesOf(text) {
  return stripMd(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

function needLine(text) {
  const sentences = sentencesOf(text);
  for (let i = sentences.length - 1; i >= Math.max(0, sentences.length - 6); i--) {
    if (isQuestionSentence(sentences[i])) return clip(sentences[i], 160);
  }
  return clip(lastParagraph(text), 160);
}

function looksLikeQuestion(text) {
  const last = sentencesOf(lastParagraph(text));
  return last.slice(-3).some(isQuestionSentence) || QUESTION_HINTS.test(last.slice(-3).join(' '));
}

function isChildThread(id, payload) {
  if (/^thread:(subagent|delegated-task)/.test(id)) return true;
  const lin = payload && payload.lineage;
  // A fork is a thread of its own that the user works in, so it is not a child.
  return !!(lin && lin.parentThreadId && lin.relationshipToParent !== 'fork');
}

/**
 * Returns { ok, error?, serverAlive, threads: [...], counts }
 * Each thread: { id, title, project, state, detail, steps, updatedAt, runId, runStatus, completedAt }
 * state: waiting | needs-reply | failed | running | stale | done | stopped | idle
 */
function readSnapshot({ dbPath = DEFAULT_DB, lookbackHours = 72 } = {}) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { ok: false, error: 'Cannot open T3 database: ' + e.message, threads: [], counts: {} };
  }
  try {
    const since = new Date(Date.now() - lookbackHours * 3600e3).toISOString();
    const serverAlive = t3ServerAlive();

    const projects = new Map();
    for (const p of db.prepare('select project_id, title from projection_projects where deleted_at is null').all()) {
      projects.set(p.project_id, p.title);
    }

    // Latest run per thread.
    const lastRuns = new Map();
    for (const r of db.prepare(`
      select r.run_id, r.thread_id, r.status, r.requested_at, r.completed_at
      from orchestration_v2_projection_runs r
      join (select thread_id, max(ordinal) mo from orchestration_v2_projection_runs group by thread_id) m
        on r.thread_id = m.thread_id and r.ordinal = m.mo`).all()) {
      lastRuns.set(r.thread_id, r);
    }

    const activeThreadIds = new Set(
      [...lastRuns.values()].filter(r => RUN_ACTIVE.has(r.status)).map(r => r.thread_id)
    );

    // Unresolved requests (approvals, questions, secrets) from both tables.
    const pending = new Map();
    const addPending = (threadId, text) => {
      if (!pending.has(threadId)) pending.set(threadId, []);
      pending.get(threadId).push(text);
    };
    for (const q of db.prepare('select thread_id, kind, status, payload_json from orchestration_v2_projection_runtime_requests where resolved_at is null').all()) {
      if (REQUEST_DONE.has(String(q.status))) continue;
      let p = {}; try { p = JSON.parse(q.payload_json); } catch {}
      addPending(q.thread_id, clip(p.prompt || p.title || (q.kind === 'command' ? 'Approve a command' : 'Answer a question'), 160));
    }
    for (const it of db.prepare(`select thread_id, type, status, payload_json from orchestration_v2_projection_turn_items
        where type in ('approval_request','user_input_request','secret_request','link_request')`).all()) {
      if (ITEM_DONE.has(String(it.status))) continue;
      let p = {}; try { p = JSON.parse(it.payload_json); } catch {}
      const fallback = it.type === 'approval_request' ? 'Approval needed' : it.type === 'secret_request' ? 'A secret or login is needed' : it.type === 'link_request' ? 'A link or connection needs you' : 'Answer needed';
      addPending(it.thread_id, clip(p.prompt || p.title || fallback, 160));
    }

    const threadRows = db.prepare(`select thread_id, title, project_id, updated_at, payload_json
      from orchestration_v2_projection_threads
      where deleted_at is null and archived_at is null`).all();

    const lastAssistant = db.prepare(`select json_extract(payload_json,'$.text') t from orchestration_v2_projection_messages
      where thread_id = ? and role = 'assistant' and message_id not like '%thinking%'
      order by created_at desc limit 1`);
    const todo = db.prepare(`select payload_json from orchestration_v2_projection_turn_items
      where thread_id = ? and type = 'todo_list' order by updated_at desc limit 1`);

    const now = Date.now();
    const threads = [];
    for (const row of threadRows) {
      let p = {}; try { p = JSON.parse(row.payload_json); } catch {}
      if (isChildThread(row.thread_id, p)) continue;
      if (p.snoozedUntil && Date.parse(p.snoozedUntil) > now) continue;
      const run = lastRuns.get(row.thread_id);
      const recent = row.updated_at >= since;
      const isActive = activeThreadIds.has(row.thread_id) || pending.has(row.thread_id);
      if (!recent && !isActive) continue;
      if (p.settledAt && !isActive && (!run || (run.requested_at || '') <= p.settledAt)) continue;

      // Ignore a visit time in the future (clock skew) so a finished run is not hidden as already seen.
      const visited = p.lastVisitedAt && Date.parse(p.lastVisitedAt) <= now ? p.lastVisitedAt : '';
      const unseen = run && run.completed_at && run.completed_at > visited;
      let state = 'idle';
      let detail = '';
      let steps = null;

      if (pending.has(row.thread_id)) {
        state = 'waiting';
        detail = pending.get(row.thread_id)[0];
      } else if (run && RUN_ACTIVE.has(run.status)) {
        state = serverAlive ? 'running' : 'stale';
      } else if (run && run.status === 'failed' && unseen) {
        state = 'failed';
      } else if (run && run.status === 'completed' && unseen) {
        state = 'done';
      } else if (run && (run.status === 'interrupted' || run.status === 'cancelled') && unseen) {
        state = 'stopped';
      }

      if (state !== 'idle' || recent) {
        const t = lastAssistant.get(row.thread_id);
        const text = t && t.t;
        if (state === 'done' && text && looksLikeQuestion(text)) state = 'needs-reply';
        if (!detail && text) detail = state === 'running' ? clip(lastParagraph(text), 140) : needLine(text);
        if (state === 'running') {
          const td = todo.get(row.thread_id);
          if (td) {
            try {
              const tp = JSON.parse(td.payload_json);
              if (tp.runId === run.run_id && Array.isArray(tp.steps)) {
                steps = tp.steps.map(s => ({ text: clip(s.text, 90), status: s.status }));
              }
            } catch {}
          }
        }
      }

      threads.push({
        id: row.thread_id,
        title: row.title || 'Untitled thread',
        project: projects.get(row.project_id) || '',
        projectId: row.project_id,
        state,
        detail,
        steps,
        updatedAt: row.updated_at,
        runId: run ? run.run_id : null,
        runStatus: run ? run.status : null,
        completedAt: run ? run.completed_at : null,
      });
    }

    const rank = { waiting: 0, 'needs-reply': 1, failed: 2, running: 3, stale: 4, done: 5, stopped: 6, idle: 7 };
    threads.sort((a, b) => (rank[a.state] - rank[b.state]) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const counts = {};
    for (const t of threads) counts[t.state] = (counts[t.state] || 0) + 1;
    return { ok: true, serverAlive, threads, counts, at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: 'T3 database query failed (schema may have changed): ' + e.message, threads: [], counts: {} };
  } finally {
    try { db.close(); } catch {}
  }
}

/** This machine's per-thread "last visited" times from T3's local database (read-only), or null. */
function readLocalVisits(dbPath = DEFAULT_DB) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const out = new Map();
    for (const r of db.prepare(`select thread_id, json_extract(payload_json,'$.lastVisitedAt') v
        from orchestration_v2_projection_threads where deleted_at is null`).all()) {
      if (r.v && Date.parse(r.v) <= Date.now()) out.set(r.thread_id, r.v);
    }
    return out;
  } catch {
    return null;
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

/** Compare two snapshots and return notification events (never on the first snapshot). */
function diffSnapshots(prev, next) {
  if (!prev || !prev.ok || !next.ok) return [];
  const keyOf = t => t.key || t.id;
  const before = new Map(prev.threads.map(t => [keyOf(t), t]));
  // A machine the previous snapshot could not see (T3 started after the pet, a link came back) is new
  // to the pet, not new to the user: take its threads as they are, without a notification burst.
  // A machine counts as seen when it was reachable, or when only a request to it failed while its
  // last list was still cached (even an empty one): changes on it are real news. An expired or
  // disconnected link is not seen, so its threads don't alert when it comes back.
  const seenEnvs = prev.environments
    ? new Set(prev.environments.filter(e => !e.status || e.status === 'reachable' || e.cached).map(e => e.id))
    : new Set(prev.threads.map(t => t.envId));
  const events = [];
  for (const t of next.threads) {
    if (t.muted) continue; // muted project or schedule: never a notification
    if (t.envId && !seenEnvs.has(t.envId)) continue;
    const b = before.get(keyOf(t));
    // The first read of an old thread sets its state; no alert, unless T3's list shows a real change.
    if (t.provisional || (b && b.provisional && b.status === t.status && b.runId === t.runId)) continue;
    const was = b ? b.state : 'idle';
    if (t.state === was && (!b || b.runId === t.runId)) continue;
    if (t.state === 'waiting' && was !== 'waiting') events.push({ kind: 'waiting', thread: t });
    else if (t.state === 'needs-reply' && was !== 'needs-reply') events.push({ kind: 'needs-reply', thread: t });
    else if (t.state === 'failed' && was !== 'failed') events.push({ kind: 'failed', thread: t });
    else if (t.state === 'done' && (was === 'running' || was === 'waiting' || was === 'stale' || (b && b.runId !== t.runId))) events.push({ kind: 'done', thread: t });
  }
  return events;
}

/** The pet's overall mood: the most urgent thread state, mapped to a Codex pet animation row. */
function petMood(snapshot) {
  if (snapshot && snapshot.problem && ['not-installed', 'not-started', 'not-running', 'no-cli'].includes(snapshot.problem.code) && !snapshot.ok) {
    return { anim: 'idle', label: 'Waiting for T3' }; // a set-up step, not a failure: keep the pet calm
  }
  if (!snapshot || !snapshot.ok) return { anim: 'failed', label: 'Cannot read T3' };
  const c = snapshot.counts || {};
  const need = (c.waiting || 0) + (c['needs-reply'] || 0);
  if (need) return { anim: 'waiting', label: `${need} need${need === 1 ? 's' : ''} you` };
  if (c.failed) return { anim: 'failed', label: `${c.failed} failed` };
  if (c.running) return { anim: 'running', label: `${c.running} running` };
  if (c.done) return { anim: 'review', label: `${c.done} finished` };
  return { anim: 'idle', label: 'All quiet' };
}

module.exports = { isChildThread, readSnapshot, readLocalVisits, diffSnapshots, petMood, needLine, looksLikeQuestion, clip, lastParagraph, DEFAULT_DB, T3_DIR };
