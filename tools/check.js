// Self-check for the watcher logic, using a synthetic copy of T3's schema (never the real database).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const w = require('../src/watcher');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3pet-check-'));
const dbPath = path.join(dir, 'state.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`
create table projection_projects (project_id text primary key, title text, deleted_at text);
create table orchestration_v2_projection_threads (thread_id text primary key, project_id text, title text, updated_at text, archived_at text, deleted_at text, payload_json text);
create table orchestration_v2_projection_runs (run_id text primary key, thread_id text, ordinal int, status text, requested_at text, completed_at text);
create table orchestration_v2_projection_runtime_requests (runtime_request_id text primary key, thread_id text, kind text, status text, created_at text, resolved_at text, payload_json text);
create table orchestration_v2_projection_turn_items (turn_item_id text primary key, thread_id text, type text, status text, updated_at text, payload_json text);
create table orchestration_v2_projection_messages (message_id text primary key, thread_id text, role text, created_at text, payload_json text);
`);
const now = Date.now();
const iso = m => new Date(now + m * 60000).toISOString();
db.prepare('insert into projection_projects values (?,?,null)').run('p1', 'Demo project');
const thread = (id, title, payload = {}) =>
  db.prepare('insert into orchestration_v2_projection_threads values (?,?,?,?,null,null,?)').run(id, 'p1', title, iso(-1), JSON.stringify({ lineage: { parentThreadId: null }, lastVisitedAt: iso(-30), ...payload }));
const run = (tid, ord, status, completed) =>
  db.prepare('insert or replace into orchestration_v2_projection_runs values (?,?,?,?,?,?)').run(`run:${tid}:${ord}`, tid, ord, status, iso(-20), completed);
const msg = (tid, id, text, at) =>
  db.prepare('insert into orchestration_v2_projection_messages values (?,?,?,?,?)').run(id, tid, 'assistant', at, JSON.stringify({ text }));

thread('A', 'Build feature');            run('A', 1, 'running', null);
thread('B', 'Write report');             run('B', 1, 'completed', iso(-5)); msg('B', 'mB', 'Report done. Should I send it to the team?', iso(-5));
thread('C', 'Old seen task');            run('C', 1, 'completed', iso(-40));
thread('D', 'Deploy');                   run('D', 1, 'running', null);
thread('thread:subagent:x', 'Child', { lineage: { parentThreadId: 'A' } }); run('thread:subagent:x', 1, 'running', null);
thread('E', 'Git status');               run('E', 1, 'completed', iso(-5)); msg('E', 'mE', 'Changed files: audit/, ?? new.txt. All committed.', iso(-5));

const s1 = w.readSnapshot({ dbPath });
assert.ok(s1.ok, s1.error);
const st = id => (s1.threads.find(t => t.id === id) || {}).state;
assert.strictEqual(st('A'), 'running');
assert.strictEqual(st('B'), 'needs-reply');
assert.strictEqual(st('C'), 'idle');
assert.strictEqual(st('E'), 'done', '"??" in git output must not count as a question');
assert.ok(!s1.threads.find(t => t.id === 'thread:subagent:x'), 'child threads are hidden');
assert.strictEqual(w.diffSnapshots(null, s1).length, 0, 'no notifications for the first snapshot');
assert.strictEqual(w.petMood(s1).anim, 'waiting');

// Transitions: A finishes, D asks for approval.
run('A', 1, 'completed', iso(0));
msg('A', 'mA', 'Feature built and tests pass.', iso(0));
db.prepare('insert into orchestration_v2_projection_runtime_requests values (?,?,?,?,?,null,?)').run('r1', 'D', 'command', 'pending', iso(0), JSON.stringify({ prompt: 'Allow npm publish?' }));
const s2 = w.readSnapshot({ dbPath });
const ev = w.diffSnapshots(s1, s2).map(e => e.kind + ':' + e.thread.id).sort();
assert.deepStrictEqual(ev, ['done:A', 'waiting:D']);
assert.strictEqual(s2.threads.find(t => t.id === 'D').detail, 'Allow npm publish?');

// A pending approval as a turn item also counts; resolving it clears the waiting state.
db.prepare('update orchestration_v2_projection_runtime_requests set status=?, resolved_at=? where runtime_request_id=?').run('resolved', iso(1), 'r1');
db.prepare('insert into orchestration_v2_projection_turn_items values (?,?,?,?,?,?)').run('ti1', 'A', 'approval_request', 'running', iso(1), JSON.stringify({ prompt: 'Approve file write' }));
const s3 = w.readSnapshot({ dbPath });
assert.strictEqual(s3.threads.find(t => t.id === 'A').state, 'waiting');
assert.strictEqual(s3.threads.find(t => t.id === 'D').state, 'running');

// Visiting a finished thread marks it seen.
db.prepare('update orchestration_v2_projection_threads set payload_json=? where thread_id=?').run(JSON.stringify({ lineage: {}, lastVisitedAt: iso(0) }), 'B');
const s4 = w.readSnapshot({ dbPath });
assert.strictEqual(s4.threads.find(t => t.id === 'B').state, 'idle');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('database fallback checks passed');

// ---- State rules for threads read through T3's MCP tools (all machines) ----
const { deriveState } = require('../src/tasks');
const T = (o = {}) => ({ id: 'x', runId: 'r1', isLocal: false, updatedAt: iso(-2), completedAt: iso(-2), status: 'completed', ...o });
const S = (t, x) => deriveState(t, { now, ...x }).state;
assert.strictEqual(S(T({ status: 'running', completedAt: null })), 'running');
assert.strictEqual(S(T({ status: 'waiting', completedAt: null }), { pendingRequestCount: 1 }), 'waiting', 'a pending request needs you');
assert.strictEqual(S(T({ status: 'waiting', completedAt: null, blocked: true }), { pendingRequestCount: 0 }), 'running', 'waiting on a sub-task is still work');
assert.strictEqual(S(T({ status: 'waiting', completedAt: null }), { pendingRequestCount: 0 }), 'running', 'waiting without a request is not "needs you"');
assert.strictEqual(S(T(), { lastText: 'Done. Want me to deploy it?' }), 'needs-reply');
assert.strictEqual(S(T(), { lastText: 'All done.' }), 'done');
assert.strictEqual(S(T({ completedAt: iso(-45) }), { lastText: 'All done.' }), 'idle', 'remote: T3 marks finished threads read after 30 minutes');
assert.strictEqual(S(T({ isLocal: true }), { visitedAt: iso(-1) }), 'idle', 'local: visited after it finished');
assert.strictEqual(S(T({ isLocal: true }), { visitedAt: iso(-10) }), 'done', 'local: visited before it finished');
assert.strictEqual(S(T(), { dismissedRunId: 'r1' }), 'idle', 'dismissed in the pet');
assert.strictEqual(S(T({ runId: 'r2' }), { dismissedRunId: 'r1' }), 'done', 'a new run brings it back');
assert.strictEqual(S(T({ status: 'failed' })), 'failed');
assert.strictEqual(S(T({ status: 'interrupted' })), 'stopped');
const keyed = (k, state, runId) => ({ key: k, id: k.split('/')[1], state, runId, title: k });
assert.deepStrictEqual(
  w.diffSnapshots({ ok: true, threads: [keyed('pc/a', 'running', 'r1'), keyed('mac/a', 'running', 'r1')] }, { ok: true, threads: [keyed('pc/a', 'running', 'r1'), keyed('mac/a', 'done', 'r1')] }).map(e => e.kind + ':' + e.thread.key),
  ['done:mac/a'], 'same thread id on two machines stays separate');
// A machine that was not visible before (T3 started after the pet, or a link came back) must not
// fire a notification for every thread it already had.
const th = (env, id, state) => ({ key: `${env}/${id}`, id, envId: env, state, runId: 'r1', title: id });
const local = { id: 'mac', isLocal: true, status: 'reachable' };
const dbOnly = { ok: true, source: 'database', environments: [local], threads: [th('mac', 'a', 'done')] };
const both = { ok: true, source: 'mcp', environments: [local, { id: 'pc', status: 'reachable' }], threads: [th('mac', 'a', 'done'), th('pc', 'b', 'needs-reply'), th('pc', 'c', 'failed')] };
assert.deepStrictEqual(w.diffSnapshots(dbOnly, both), [], 'T3 started after the pet: no burst');
const pcDown = { ...both, environments: [local, { id: 'pc', status: 'error' }], threads: [th('mac', 'a', 'done')] };
assert.deepStrictEqual(w.diffSnapshots(pcDown, both), [], 'a link came back: no burst');
const later = { ...both, threads: [th('mac', 'a', 'done'), th('pc', 'b', 'needs-reply'), th('pc', 'c', 'failed'), th('pc', 'd', 'waiting')] };
assert.deepStrictEqual(w.diffSnapshots(both, later).map(e => e.kind + ':' + e.thread.key), ['waiting:pc/d'], 'a real change on a seen machine still notifies');
assert.strictEqual(w.petMood({ ok: false, problem: { code: 'not-installed' } }).anim, 'idle', 'no T3 yet: a calm pet, not a sad one');
const expired = { ...both, environments: [local, { id: 'pc', status: 'expired' }], threads: [th('mac', 'a', 'done')] };
assert.deepStrictEqual(w.diffSnapshots(expired, both), [], 'an expired link that comes back: no burst');
const downCached = { ...both, environments: [local, { id: 'pc', status: 'error', cached: true }], threads: [th('mac', 'a', 'done'), th('pc', 'b', 'running')] };
assert.deepStrictEqual(w.diffSnapshots(downCached, later).map(e => e.kind + ':' + e.thread.key).sort(), ['failed:pc/c', 'needs-reply:pc/b', 'waiting:pc/d'], 'a short outage with cached threads: real changes still alert');
const expiredCached = { ...downCached, environments: [local, { id: 'pc', status: 'expired' }] };
assert.deepStrictEqual(w.diffSnapshots(expiredCached, later), [], 'an expired link with cached threads: no alerts when it comes back');
const emptyOutage = { ...both, environments: [local, { id: 'pc', status: 'error', cached: true }], threads: [th('mac', 'a', 'done')] };
assert.deepStrictEqual(w.diffSnapshots(emptyOutage, { ...both, threads: [th('mac', 'a', 'done'), th('pc', 'd', 'waiting')] }).map(e => e.kind + ':' + e.thread.key), ['waiting:pc/d'], 'a hiccup on a machine with an empty list: a new request still alerts');
const stp = (k, state, status, provisional) => ({ ...th('pc', k, state), status, provisional });
assert.deepStrictEqual(w.diffSnapshots({ ...both, threads: [stp('f', 'running', 'running', true)] }, { ...both, threads: [stp('f', 'waiting', 'waiting', false)] }).length, 1, 'an unread thread whose T3 status changed still alerts');
const mutedLater = { ...both, threads: [th('mac', 'a', 'done'), th('pc', 'b', 'needs-reply'), th('pc', 'c', 'failed'), { ...th('pc', 'd', 'waiting'), muted: true }] };
assert.deepStrictEqual(w.diffSnapshots(both, mutedLater), [], 'a muted project or schedule never notifies');
// The first detail read of a thread (pending approvals, a question at the end) is its starting state.
const pv = (k, state, provisional) => ({ ...th('pc', k, state), provisional });
assert.deepStrictEqual(w.diffSnapshots({ ...both, threads: [pv('e', 'running', true)] }, { ...both, threads: [pv('e', 'waiting', false)] }), [], 'first read: no alert');
assert.deepStrictEqual(w.diffSnapshots({ ...both, threads: [pv('e', 'running', false)] }, { ...both, threads: [pv('e', 'waiting', false)] }).length, 1, 'a later change still alerts');
console.log('state rule checks passed');
