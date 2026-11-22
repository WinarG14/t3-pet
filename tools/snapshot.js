// Prints what the pet sees right now (all machines). Run: npm run snapshot
// Uses a temporary read-only T3 session and revokes it afterwards.
const { T3Client } = require('../src/t3client');
const { TaskSource } = require('../src/tasks');
const store = {};
const client = new T3Client({ loadSecret: n => store[n] || null, saveSecret: (n, v) => { store[n] = v; } });
const src = new TaskSource({ client, getSettings: () => ({ lookbackHours: 72, remotePollMs: 10000 }) });
(async () => {
  const s = await src.snapshot();
  console.log(`source: ${s.source}${s.notice ? ` (${s.notice})` : ''} | counts: ${JSON.stringify(s.counts)}`);
  for (const e of s.environments || []) console.log(`machine: ${e.label}${e.isLocal ? ' (this computer)' : ''} ${e.status}`);
  for (const t of (s.threads || []).slice(0, 20)) {
    console.log(`${t.state.padEnd(11)} ${(t.isLocal ? 'local' : t.envLabel).padEnd(12)} ${t.title.slice(0, 40).padEnd(40)} | ${(t.detail || '').slice(0, 70)}`);
  }
  if (store.read) await client.revokeSession(store.read.sessionId);
})().catch(e => { console.error(e.message); process.exit(1); });
