// Small platform helpers so the rest of the app stays the same on Windows, macOS and Linux.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function defaultPython() {
  return IS_WIN ? 'py' : 'python3';
}

/** Where T3 Code's desktop app usually lives. Returns the first that exists, else the most likely one. */
function defaultT3App() {
  const candidates = IS_WIN
    ? ['T3 Code (Beta).exe', 'T3 Code.exe'].map(n => path.join(process.env.LOCALAPPDATA || '', 'Programs', 't3code', n))
    : IS_MAC
      ? ['/Applications/T3 Code (Beta).app', '/Applications/T3 Code.app', path.join(os.homedir(), 'Applications', 'T3 Code (Beta).app'), path.join(os.homedir(), 'Applications', 'T3 Code.app')]
      : [];
  return candidates.find(p => fs.existsSync(p)) || candidates[0] || '';
}

/** Bring T3 Code to the front (or start it). Calls onFail() when that did not work. */
function openT3App(appPath, onFail = () => {}) {
  try {
    if (IS_MAC) {
      const child = spawn('open', appPath && fs.existsSync(appPath) ? ['-a', appPath] : ['-a', 'T3 Code (Beta)'], { stdio: 'ignore' });
      child.on('error', onFail);
      child.on('exit', code => { if (code !== 0) onFail(); }); // `open` exits 1 when it cannot find the app
      return;
    }
    if (appPath && fs.existsSync(appPath)) {
      const child = spawn(appPath, [], { detached: true, stdio: 'ignore' });
      child.on('error', onFail);
      child.unref();
      return;
    }
  } catch {}
  onFail();
}

/**
 * macOS, run from source (`npm start`): start at sign-in through a per-user LaunchAgent.
 * app.setLoginItemSettings registers the running bundle only (here the bare Electron.app, which would
 * open Electron's default window), and its path/args options are Windows-only. The agent runs Electron
 * with this app's folder and the PATH of the current session, so `codex` and `python3` resolve as in a
 * terminal. Returns true when the agent file matches `on`.
 */
function setMacDevLoginItem(on, { label, execPath, appPath, envPath }) {
  const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  try {
    if (!on) {
      fs.rmSync(file, { force: true });
      return true;
    }
    const x = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${x(execPath)}</string><string>${x(appPath)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${x(envPath || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plist);
    return true;
  } catch {
    return false;
  }
}

/** Stop a child process and everything it started. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
}

module.exports = { IS_WIN, IS_MAC, defaultPython, defaultT3App, openT3App, killTree, setMacDevLoginItem };
