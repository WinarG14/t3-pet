// Talks to the running T3 Code server through its official MCP endpoint (the same tools T3's own
// `t3 thread` CLI uses). Two credentials, both visible and revocable in T3 → Settings → Sharing & access:
//   - read:    a read-only MCP client session issued by the owner CLI (`t3 auth session issue`).
//   - actions: an optional full-access MCP sign-in (OAuth), approved with a one-time approval code that
//              the owner CLI can mint. Needed for settle / mark unread / snooze, because T3 only lets a
//              caller organize threads that run at or below the caller's own access level.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const READ_LABEL = 'T3 Pet (read-only)';
const ACTIONS_LABEL = 'T3 Pet (actions)';

function t3Home() {
  return process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
}

class McpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One MCP (streamable HTTP) session for one bearer token. */
class McpSession {
  constructor(getOrigin, token) {
    this.getOrigin = getOrigin;
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
    this.ready = null;
  }

  async post(body) {
    const headers = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(new URL('/mcp', this.getOrigin()), { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new McpError('T3 is not reachable: ' + e.message, { code: 'unreachable' });
    } finally {
      clearTimeout(timer);
    }
    this.sessionId = res.headers.get('mcp-session-id') || this.sessionId;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new McpError('T3 refused the credential', { status: res.status, code: 'unauthorized' });
    if (body.id === undefined) return null;
    let msg;
    try {
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        const datas = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
        msg = JSON.parse(datas[datas.length - 1]);
      } else {
        msg = JSON.parse(text);
      }
    } catch {
      throw new McpError(`Unexpected reply from T3 (${res.status})`, { status: res.status, code: res.status === 404 ? 'session' : 'bad_reply' });
    }
    if (msg.error) throw new McpError(msg.error.message || 'MCP error', { status: res.status, code: res.status === 404 ? 'session' : 'rpc' });
    return msg.result;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't3-pet', version: '0.2.0' } } });
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      })().catch(e => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async callTool(name, args) {
    await this.init();
    let result;
    try {
      result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
    } catch (e) {
      if (e.code === 'session') { // session expired on the server: start a new one once
        this.sessionId = null;
        this.ready = null;
        await this.init();
        result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
      } else throw e;
    }
    const text = (result && result.content || []).map(c => c.text || '').join('');
    let data;
    try { data = JSON.parse(text); } catch { data = { text }; }
    if (data && data._tag === 'OrchestratorMcpFailure') throw new McpError(data.message || data.code, { code: data.code });
    if (result && result.isError) throw new McpError(text.slice(0, 300) || 'tool error', { code: 'tool' });
    return data;
  }
}

class T3Client {
  /**
   * @param {object} o
   * @param {(name: string) => object|null} o.loadSecret   returns a stored credential object or null
   * @param {(name: string, value: object|null) => void} o.saveSecret
   * @param {(line: string) => void} [o.log]
   */
  constructor({ loadSecret, saveSecret, log = () => {} }) {
    this.loadSecret = loadSecret;
    this.saveSecret = saveSecret;
    this.log = log;
    this.home = t3Home();
    this.sessions = {};
    this.lastIssueAttempt = 0;
  }

  get userdata() { return path.join(this.home, 'userdata'); }
  get cliPath() { return path.join(this.home, 'bin', IS_WIN ? 't3.cmd' : 't3'); }

  origin() {
    const rt = JSON.parse(fs.readFileSync(path.join(this.userdata, 'server-runtime.json'), 'utf8'));
    return rt.origin;
  }

  serverRunning() {
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(this.userdata, 'server-runtime.json'), 'utf8'));
      if (rt.pid) process.kill(rt.pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  cliAvailable() {
    return fs.existsSync(this.cliPath);
  }

  /** Run the owner CLI (`t3 ...`). Resolves { code, stdout, stderr }. */
  cli(args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const quote = a => (IS_WIN && /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      // On Windows the CLI is a .cmd file, which needs a shell; pass one quoted command line.
      const child = IS_WIN
        ? spawn([quote(this.cliPath), ...args.map(quote)].join(' '), { shell: true, windowsHide: true })
        : spawn(this.cliPath, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('t3 CLI timed out')); }, timeoutMs);
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  async issueSession(args) {
    const r = await this.cli(['auth', 'session', 'issue', ...args, '--json']);
    if (r.code !== 0) throw new Error('t3 auth session issue failed: ' + (r.stderr || r.stdout).trim().slice(0, 200));
    const j = JSON.parse(r.stdout);
    return { token: j.token, sessionId: j.sessionId, expiresAt: j.expiresAt };
  }

  async revokeSession(sessionId) {
    if (!sessionId) return;
    try { await this.cli(['auth', 'session', 'revoke', sessionId]); } catch {}
  }

  /** Read-only MCP client session (subject "mcp-client" is what T3's MCP endpoint accepts). */
  async readCredential({ forceNew = false } = {}) {
    let cred = forceNew ? null : this.loadSecret('read');
    if (cred && cred.expiresAt && Date.parse(cred.expiresAt) < Date.now() + 3600e3) cred = null;
    if (cred) return cred;
    if (Date.now() - this.lastIssueAttempt < 60e3) throw new McpError('Waiting before asking T3 for a new token', { code: 'backoff' });
    this.lastIssueAttempt = Date.now();
    if (!this.cliAvailable()) throw new McpError(`T3's command-line tool was not found at ${this.cliPath}. Open T3 Code once so it installs it.`, { code: 'no_cli' });
    const old = this.loadSecret('read');
    cred = await this.issueSession(['--subject', 'mcp-client', '--scope', 'orchestration:read', '--ttl', '30d', '--label', READ_LABEL]);
    this.saveSecret('read', cred);
    if (old && old.sessionId && old.sessionId !== cred.sessionId) this.revokeSession(old.sessionId);
    this.log('Issued a read-only T3 session for T3 Pet.');
    return cred;
  }

  async session(kind) {
    const cred = kind === 'actions' ? this.loadSecret('actions') : await this.readCredential();
    if (!cred) throw new McpError('Thread actions are not enabled. Turn them on in Settings.', { code: 'actions_off' });
    const s = this.sessions[kind];
    if (s && s.token === cred.token) return s;
    this.sessions[kind] = new McpSession(() => this.origin(), cred.token);
    return this.sessions[kind];
  }

  /** Call an MCP tool. kind 'read' (default) or 'actions'. Retries once with a fresh read token on 401. */
  async call(tool, args = {}, kind = 'read') {
    const s = await this.session(kind);
    try {
      return await s.callTool(tool, args);
    } catch (e) {
      if (e.code !== 'unauthorized') throw e;
      delete this.sessions[kind];
      if (kind === 'actions') {
        this.saveSecret('actions', null);
        throw new McpError('T3 no longer accepts the actions sign-in (expired or revoked). Enable actions again in Settings.', { code: 'actions_off' });
      }
      await this.readCredential({ forceNew: true });
      return (await this.session('read')).callTool(tool, args);
    }
  }

  // ---------- actions sign-in (OAuth, approved by an owner-issued one-time code) ----------
  async enableActions() {
    if (!this.cliAvailable()) throw new Error(`T3's command-line tool was not found at ${this.cliPath}.`);
    const origin = this.origin();
    // A 5-minute owner session that may mint an approval code. Revoked as soon as we are done.
    const setup = await this.issueSession(['--ttl', '5m', '--label', 'T3 Pet setup']);
    try {
      const pc = await fetch(`${origin}/api/auth/pairing-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${setup.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access: 'full-access', label: ACTIONS_LABEL }),
      });
      const pcj = await pc.json().catch(() => ({}));
      if (!pc.ok || !pcj.credential) throw new Error(`T3 did not issue an approval code (${pc.status} ${pcj.code || ''})`);

      const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const redirectUri = 'http://127.0.0.1:9/t3-pet-callback'; // never opened: the decision API returns the redirect
      const reg = await fetch(`${origin}/oauth/mcp/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: ACTIONS_LABEL, redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      });
      const client = await reg.json();
      if (!reg.ok || !client.client_id) throw new Error(`T3 refused the client registration (${reg.status})`);
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const state = b64url(crypto.randomBytes(16));
      const resource = `${origin}/mcp`;
      const authorization = { response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource };
      const dec = await fetch(`${origin}/oauth/mcp/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorization, decision: { _tag: 'pairing-code', access: 'full-access', code: pcj.credential } }),
      });
      const decj = await dec.json().catch(() => ({}));
      if (!dec.ok || !decj.redirectTo) throw new Error(`T3 did not approve the sign-in (${dec.status})`);
      const back = new URL(decj.redirectTo);
      if (back.searchParams.get('state') !== state) throw new Error('Sign-in state mismatch');
      const tok = await fetch(`${origin}/oauth/mcp/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource }),
      });
      const tj = await tok.json().catch(() => ({}));
      if (!tok.ok || !tj.access_token) throw new Error(`T3 did not issue the token (${tok.status})`);
      const cred = { token: tj.access_token, expiresAt: new Date(Date.now() + (tj.expires_in || 0) * 1000).toISOString() };
      this.saveSecret('actions', cred);
      delete this.sessions.actions;
      this.log('Thread actions enabled.');
      return cred;
    } finally {
      await this.revokeSession(setup.sessionId);
    }
  }

  /** Revoke every T3 Pet actions session (found by label) and forget the token. */
  async disableActions() {
    this.saveSecret('actions', null);
    delete this.sessions.actions;
    const r = await this.cli(['auth', 'session', 'list', '--json']).catch(() => null);
    if (!r || r.code !== 0) return;
    let list = [];
    try { const j = JSON.parse(r.stdout); list = Array.isArray(j) ? j : (j.sessions || []); } catch {}
    for (const s of list) {
      const label = (s.client && s.client.label) || s.label;
      if (label === ACTIONS_LABEL) await this.revokeSession(s.sessionId);
    }
  }
}

module.exports = { T3Client, McpError, READ_LABEL, ACTIONS_LABEL, t3Home };
