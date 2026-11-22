// Minimal client for `codex app-server` (JSON-RPC over stdio, one JSON message per line).
// The built-in image_gen tool is only offered to app-server clients (as T3 and the Codex app use),
// not to `codex exec`, so the pet builder drives Codex this way.
const { spawn } = require('child_process');
const readline = require('readline');
const { killTree } = require('./platform');

class CodexAppServer {
  constructor({ codexCmd = 'codex', onLog = () => {}, onEvent = () => {} } = {}) {
    this.codexCmd = codexCmd;
    this.onLog = onLog;
    this.onEvent = onEvent;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
  }

  start() {
    this.child = spawn(this.codexCmd, ['app-server'], { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', e => this.failAll(e));
    this.child.on('close', code => this.failAll(new Error(`codex app-server exited (${code})`)));
    this.child.stderr.on('data', d => { const s = d.toString().trim(); if (s) this.onLog('[codex] ' + s.slice(0, 400)); });
    readline.createInterface({ input: this.child.stdout }).on('line', line => this.onLine(line));
  }

  failAll(err) {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      // Server-to-client request (approvals, user input). We run with approvalPolicy "never",
      // so these should not arrive; decline anything that does so the turn cannot hang.
      this.onLog(`[codex] server request ${msg.method}: declining`);
      this.write({ id: msg.id, result: { decision: 'decline' } });
      return;
    }
    if (msg.method) {
      this.onEvent(msg);
      for (const w of [...this.waiters]) {
        if (w.match(msg)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
      }
    }
  }

  write(obj) {
    if (this.closed) throw new Error('codex app-server is not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  waitFor(match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      this.waiters.push(w);
      if (timeoutMs) setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('Timed out waiting for Codex')); }
      }, timeoutMs);
    });
  }

  async init() {
    this.start();
    await this.request('initialize', { clientInfo: { name: 't3-pet', title: 'T3 Pet', version: '0.1.0' } });
    this.notify('initialized');
  }

  /** Run one turn to completion. Returns { threadId, turn, items } where items are completed thread items. */
  async runTurn({ cwd, model, text, timeoutMs = 60 * 60e3 }) {
    const params = { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' };
    if (model) params.model = model;
    let started;
    try {
      started = await this.request('thread/start', params);
    } catch (e) {
      // The configured default model can be refused for some sign-ins: try the account's listed models.
      if (model) throw e;
      started = null;
      for (const m of await this.listModels()) {
        try {
          started = await this.request('thread/start', { ...params, model: m });
          this.onLog(`[codex] using model ${m}`);
          break;
        } catch {}
      }
      if (!started) throw e;
    }
    const threadId = (started.thread && started.thread.id) || started.threadId;
    const items = [];
    const prevOnEvent = this.onEvent;
    this.onEvent = msg => {
      if (msg.method === 'item/completed' && msg.params && msg.params.threadId === threadId) items.push(msg.params.item);
      prevOnEvent(msg);
    };
    const done = this.waitFor(m => m.method === 'turn/completed' && m.params && m.params.threadId === threadId, timeoutMs);
    await this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    const fin = await done;
    this.onEvent = prevOnEvent;
    return { threadId, turn: fin.params.turn, items };
  }

  /** Model ids this account can use, default first (from `model/list`). */
  async listModels() {
    try {
      const r = await this.request('model/list', {});
      const arr = (r && (r.data || r.models || r.items)) || (Array.isArray(r) ? r : []);
      const usable = arr.filter(m => !m.hidden && m.visibility !== 'hide');
      usable.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
      return usable.map(m => m.model || m.id || m.slug).filter(Boolean);
    } catch {
      return [];
    }
  }

  stop() {
    try { this.child.stdin.end(); } catch {}
    killTree(this.child);
  }
}

module.exports = { CodexAppServer };
