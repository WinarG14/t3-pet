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

/** Bring T3 Code to the front (or start it). */
function openT3App(appPath) {
  try {
    if (IS_MAC) {
      spawn('open', appPath && fs.existsSync(appPath) ? ['-a', appPath] : ['-a', 'T3 Code (Beta)'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (appPath && fs.existsSync(appPath)) {
      spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch {}
  return false;
}

/** Stop a child process and everything it started. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
}

module.exports = { IS_WIN, IS_MAC, defaultPython, defaultT3App, openT3App, killTree };
