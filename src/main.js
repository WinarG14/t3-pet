// T3 Pet: a desktop companion for T3 Code. Shows a Codex-compatible pet that reacts to T3 threads
// on this computer and on every linked environment.
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, screen, safeStorage, nativeImage, shell, dialog, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const watcher = require('./watcher');
const { listPets, ATLAS, CODEX_PETS } = require('./pets');
const { PetBuilder } = require('./builder');
const { T3Client } = require('./t3client');
const { TaskSource } = require('./tasks');
const { IS_WIN, IS_MAC, defaultPython, defaultT3App, openT3App, setMacDevLoginItem } = require('./platform');

const APP_ID = 'dev.t3pet.desktop';
app.setName('T3 Pet');
if (IS_WIN) app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const USER_DIR = app.getPath('userData');
const SETTINGS_FILE = path.join(USER_DIR, 'settings.json');
const RUNS_DIR = path.join(USER_DIR, 'pet-runs');
const ASSETS = path.join(__dirname, '..', 'assets');
const ICON = path.join(ASSETS, 'icon.png');

const DEFAULTS = {
  petId: 'dut',          // the bundled default pet
  scale: 0.6,
  motion: 'calm',          // calm: play each mood slowly, then rest in that pose; lively: loop nonstop
  normalizeSize: true,     // scale every animation row to the idle row's size
  pollMs: 3000,
  remotePollMs: 10000,
  lookbackHours: 72,
  dataSource: 'auto',      // auto: T3's MCP tools (all machines), falling back to the local database
  preciseLocalUnread: true,
  notify: { done: true, failed: true, waiting: true, 'needs-reply': true },
  sound: true,
  autoFallback: true,
  fallbackOrder: ['fal', 'venice'],
  falModel: 'openai/gpt-image-2.6/sunburst/edit',
  veniceEditModel: 'gpt-image-2-6-sunburst-edit',
  veniceModel: 'gpt-image-2-6-sunburst',
  codexCmd: 'codex',
  codexModel: '',          // blank: Codex's default, or the first model the account may use
  pythonCmd: defaultPython(),
  apiConcurrency: 3,
  t3DbPath: watcher.DEFAULT_DB,
  t3App: defaultT3App(),
  position: null,
  keys: {},
  secrets: {},
  openAtLogin: false,
};

let settings = loadSettings();
let petWin = null;
let panelWin = null;
let panelPinned = false;
let dialogOpen = false;
let tray = null;
let snapshot = null;
let pollTimer = null;
let polling = false;
let mutedUntil = 0;

function loadSettings() {
  let text;
  try { text = fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch { return { ...DEFAULTS }; } // first run
  try {
    const s = JSON.parse(text.replace(/^﻿/, '')); // tolerate a byte-order mark from Windows editors
    return { ...DEFAULTS, ...s, notify: { ...DEFAULTS.notify, ...(s.notify || {}) } };
  } catch (e) {
    // Never silently replace an unreadable file (it holds sign-ins and keys): keep a copy first.
    try { fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.unreadable-${Date.now()}`); } catch {}
    console.error('settings.json could not be read; a copy was kept and defaults are used:', e.message);
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ---------------- secrets (OS-encrypted: DPAPI on Windows, Keychain on macOS) ----------------
const memorySecrets = {};
function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(text).toString('base64');
}
function decrypt(b64) {
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return null; }
}
function loadSecret(name) {
  if (memorySecrets[name] !== undefined) return memorySecrets[name];
  const enc = settings.secrets && settings.secrets[name];
  const v = enc ? decrypt(enc) : null;
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
function saveSecret(name, value) {
  settings.secrets = settings.secrets || {};
  if (!value) {
    delete settings.secrets[name];
    delete memorySecrets[name];
  } else {
    const enc = encrypt(JSON.stringify(value));
    if (enc) settings.secrets[name] = enc;
    else memorySecrets[name] = value; // no OS encryption: keep it for this run only
  }
  saveSettings();
}
function getKey(name) {
  const enc = settings.keys && settings.keys[name];
  return enc ? decrypt(enc) : null;
}
function publicSettings() {
  const { keys, secrets, ...rest } = settings;
  const actions = loadSecret('actions');
  return {
    ...rest,
    platform: process.platform,
    keysSet: Object.fromEntries(['fal', 'venice'].map(k => [k, !!(keys && keys[k])])),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    actions: actions ? { enabled: true, expiresAt: actions.expiresAt } : { enabled: false },
  };
}

const t3 = new T3Client({ loadSecret, saveSecret, log: l => console.log('[t3]', l) });
const tasks = new TaskSource({ client: t3, getSettings: () => settings, log: l => console.log('[tasks]', l) });

const builder = new PetBuilder({ runsDir: RUNS_DIR, getKey, getSettings: () => settings });
builder.on('update', st => send(panelWin, 'builder:update', st));
builder.on('done', result => {
  send(panelWin, 'pets:list', petsPayload());
  if (result.ok) toast('Your new pet hatched', `${result.petId} is ready (built with ${result.provider}).`, () => openPanel('pets'));
  else toast('Pet build failed', result.error, () => openPanel('build'));
});

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------- pets ----------------
function currentPet() {
  const pets = listPets();
  return pets.find(p => p.id === settings.petId) || pets[0] || null;
}
function petsPayload() {
  const cur = currentPet();
  return {
    current: cur ? cur.id : null,
    folder: CODEX_PETS,
    pets: listPets().map(p => ({ id: p.id, displayName: p.displayName, description: p.description, url: pathToFileURL(p.spritesheet).href + '?v=' + Math.round(p.mtime), dir: p.dir })),
  };
}
function petConfig() {
  const pet = currentPet();
  let dataUrl = null;
  if (pet) {
    // A data URL (not file://) so windows can measure each row's size on a canvas.
    const mime = path.extname(pet.spritesheet).toLowerCase() === '.png' ? 'image/png' : 'image/webp';
    try { dataUrl = `data:${mime};base64,${fs.readFileSync(pet.spritesheet).toString('base64')}`; } catch {}
  }
  return {
    atlas: ATLAS,
    scale: settings.scale,
    motion: settings.motion,
    normalizeSize: settings.normalizeSize,
    pet: pet ? { id: pet.id, displayName: pet.displayName, url: pathToFileURL(pet.spritesheet).href, dataUrl } : null,
  };
}

// ---------------- T3 ----------------
function localEnvironmentId() {
  try { return fs.readFileSync(path.join(watcher.T3_DIR, 'environment-id'), 'utf8').trim(); } catch { return null; }
}
function focusT3() {
  // The saved path can go stale (T3 moved, renamed, or the default was saved before T3 was installed).
  if (!settings.t3App || !fs.existsSync(settings.t3App)) {
    const found = defaultT3App();
    if (found && fs.existsSync(found) && found !== settings.t3App) { settings.t3App = found; saveSettings(); }
  }
  // Last resort: T3's own link scheme, which starts or focuses it.
  openT3App(settings.t3App, () => shell.openExternal('t3code://').catch(() => {}));
}
// T3's own link format: t3code://threads/<environmentId>/<threadId>. Works for linked environments too.
function openThread(key) {
  const t = snapshot && snapshot.threads.find(x => x.key === key || x.id === key);
  const env = (t && t.envId) || localEnvironmentId();
  const id = (t && t.id) || key;
  if (!env || !id) return focusT3();
  shell.openExternal(`t3code://threads/${encodeURIComponent(env)}/${encodeURIComponent(id)}`).catch(() => focusT3());
}

// ---------------- pet event log (why did the pet show / hide / move?) ----------------
function petLog(event, detail = '') {
  try {
    const file = path.join(USER_DIR, 'pet-events.log');
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > 256 * 1024) fs.renameSync(file, file + '.old'); // keep it small
    fs.appendFileSync(file, `${new Date().toISOString()} ${event}${detail ? ' ' + detail : ''}
`);
  } catch {}
}

/**
 * Keep the pet above other windows. On Windows, showInactive() (show without stealing focus) silently
 * drops always-on-top, so the pet ended up behind maximised windows and seemed to vanish. Re-apply it.
 */
function ensurePetOnTop(reason) {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
  if (petWin.isAlwaysOnTop() && reason === 'check') return;
  petWin.setAlwaysOnTop(false);
  petWin.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (reason === 'check') petLog('on-top restored', '(was dropped)');
}

// ---------------- windows ----------------
const PET_W = 300;
const PET_H = 420; // tall enough for the bubble; empty space is click-through

// The pet's own position (settings.petPos, the sprite's top-left on screen) is kept separate from its
// window. The window always stays fully on screen; near an edge the pet moves inside the window instead,
// so the bubble can open wherever there is room (above or below, shifted left or right).
function spriteSize() {
  const s = settings.scale || 0.6;
  return { w: Math.round(192 * s), h: Math.round(208 * s) };
}
function displayFor(p, w, h) {
  return screen.getDisplayNearestPoint({ x: Math.round(p.x + w / 2), y: Math.round(p.y + h / 2) }).workArea;
}
function currentPetPos() {
  const { w, h } = spriteSize();
  let p = settings.petPos;
  if (!p && settings.position) p = { x: settings.position.x + PET_W - 8 - w, y: settings.position.y + PET_H - 4 - h }; // older setting
  if (!p) {
    const wa = screen.getPrimaryDisplay().workArea;
    p = { x: wa.x + wa.width - w - 32, y: wa.y + wa.height - h - 12 };
  }
  const d = displayFor(p, w, h);
  return { x: Math.min(Math.max(p.x, d.x), d.x + d.width - w), y: Math.min(Math.max(p.y, d.y), d.y + d.height - h) };
}
function petLayout() {
  const { w, h } = spriteSize();
  const p = currentPetPos();
  const d = displayFor(p, w, h);
  let wx = p.x - (PET_W - 8 - w); // preferred: pet near the window's bottom-right corner
  let wy = p.y - (PET_H - 4 - h);
  wx = Math.min(Math.max(wx, d.x), d.x + d.width - PET_W);
  wy = Math.min(Math.max(wy, d.y), d.y + d.height - PET_H);
  return {
    pet: p,
    win: { x: Math.round(wx), y: Math.round(wy), width: PET_W, height: PET_H },
    sprite: { x: Math.round(p.x - wx), y: Math.round(p.y - wy), w, h },
  };
}
function applyPetLayout() {
  if (!petWin || petWin.isDestroyed()) return;
  const L = petLayout();
  petWin.setBounds(L.win);
  ensurePetOnTop('check');
  send(petWin, 'pet:layout', L.sprite);
}

function createPetWindow() {
  const L = petLayout();
  petWin = new BrowserWindow({
    ...L.win,
    transparent: true, frame: false, resizable: false, movable: true, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, focusable: true, show: false, backgroundColor: '#00000000',
    title: 'T3 Pet', fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  petWin.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.setIgnoreMouseEvents(true, { forward: true });
  if (process.env.T3PET_DEBUG) {
    petWin.webContents.on('console-message', (e) => console.log('[pet]', e.level, e.message, e.sourceId ? `${path.basename(e.sourceId)}:${e.lineNumber}` : ''));
    petWin.webContents.on('render-process-gone', (_e, d) => console.log('[pet] renderer gone', JSON.stringify(d)));
  }
  petWin.webContents.on('render-process-gone', (_e, d) => setTimeout(() => recreatePetWindow('renderer gone: ' + (d && d.reason)), 500));
  petWin.on('unresponsive', () => setTimeout(() => recreatePetWindow('unresponsive'), 500));
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  petWin.webContents.on('did-finish-load', () => send(petWin, 'pet:layout', petLayout().sprite));
  petWin.once('ready-to-show', () => {
    petWin.showInactive();
    ensurePetOnTop('shown');
    petLog('pet shown', '(window created)');
    if (tray) tray.setContextMenu(trayMenu()); // the menu was built while the pet was still hidden
  });
  petWin.on('closed', () => { petWin = null; });
}

const PANEL_W = 420;
const PANEL_H = 640;

/** Place the panel beside the pet (left of it if there is room, else right), inside the screen. */
function panelBounds() {
  const { w, h } = spriteSize();
  const p = currentPetPos();
  const d = displayFor(p, w, h);
  if (!petVisible()) return { x: d.x + d.width - PANEL_W - 16, y: d.y + d.height - PANEL_H - 16 };
  let x = p.x - PANEL_W - 6;                                   // left of the pet if there is room,
  if (x < d.x + 8) x = p.x + w + 6;                            // else right of it,
  x = Math.min(Math.max(x, d.x + 8), d.x + d.width - PANEL_W - 8); // and always on screen
  let y = p.y + h - PANEL_H + 20;
  y = Math.min(Math.max(y, d.y + 8), d.y + d.height - PANEL_H - 8);
  return { x: Math.round(x), y: Math.round(y) };
}

function openPanel(tab = 'tasks') {
  if (panelWin && !panelWin.isDestroyed()) {
    if (!panelWin.isVisible()) panelWin.setBounds({ ...panelBounds(), width: PANEL_W, height: PANEL_H });
    panelWin.show();
    panelWin.focus();
    send(panelWin, 'panel:tab', tab);
    return;
  }
  const pos = panelBounds();
  panelWin = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, show: false,
    alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false,
    backgroundColor: '#00000000', hasShadow: !IS_WIN,
    ...(IS_MAC ? { vibrancy: 'popover', visualEffectState: 'active' } : {}),
    title: 'T3 Pet', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panelWin.setAlwaysOnTop(true, 'floating');
  if (process.env.T3PET_DEBUG) {
    panelWin.webContents.on('console-message', (e) => console.log('[panel]', e.level, e.message, e.sourceId ? `${path.basename(e.sourceId)}:${e.lineNumber}` : ''));
    panelWin.on('blur', () => console.log('[panel] blur'));
  }
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { query: { tab, platform: process.platform } });
  panelWin.once('ready-to-show', () => { panelWin.show(); panelWin.focus(); });
  panelWin.on('blur', () => {
    if (!panelPinned && !dialogOpen && panelWin && !panelWin.isDestroyed()) panelWin.hide();
  });
  panelWin.on('closed', () => { panelWin = null; });
}

function togglePanel(tab) {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) panelWin.hide();
  else openPanel(tab);
}

// ---------------- notifications ----------------
function toast(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: String(body || '').slice(0, 240), icon: ICON, silent: !settings.sound });
  n.on('click', () => (onClick ? onClick() : focusT3()));
  n.show();
}

const EVENT_TEXT = {
  waiting: t => [`Needs your decision: ${t.title}`, t.detail || 'A request is waiting for you in T3.'],
  'needs-reply': t => [`Asking you: ${t.title}`, t.detail || 'The task finished with a question for you.'],
  failed: t => [`Failed: ${t.title}`, t.detail || 'The run failed. Open T3 to see why.'],
  done: t => [`Done: ${t.title}`, t.detail || 'The task finished.'],
};

// ---------------- polling ----------------
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const next = await tasks.snapshot();
    const events = watcher.diffSnapshots(snapshot, next);
    snapshot = next;
    const mood = watcher.petMood(next);
    const payload = {
      snapshot: next,
      mood,
      events: events.map(e => ({ kind: e.kind, key: e.thread.key, title: e.thread.title, detail: e.thread.detail, envLabel: e.thread.isLocal ? '' : e.thread.envLabel })),
    };
    send(petWin, 'tasks:update', payload);
    send(panelWin, 'tasks:update', payload);
    updateTray(mood);
    if (Date.now() >= mutedUntil) {
      for (const e of events) {
        if (!settings.notify[e.kind]) continue;
        const [title, body] = EVENT_TEXT[e.kind](e.thread);
        toast(e.thread.isLocal ? title : `${title} (${e.thread.envLabel})`, body, () => openThread(e.thread.key));
      }
    }
  } catch (e) {
    console.error('poll failed', e);
  } finally {
    polling = false;
  }
}

/** Poll now, after any poll that is already running (a click on "Check again" must not be skipped). */
async function pollNow() {
  for (let i = 0; polling && i < 1200; i++) await new Promise(r => setTimeout(r, 100)); // the CLI can take 60 s
  // Reset right before our own poll, so a poll that was already running cannot refill the caches first.
  t3.resetBackoff();
  tasks.refreshRemotes();
  if (polling) return; // still busy after 2 minutes: the running poll already uses the reset state
  await poll();
}

function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, Math.max(1500, settings.pollMs || 3000));
}

// ---------------- tray ----------------
function trayImage() {
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
}
function trayMenu() {
  const pets = listPets();
  const cur = currentPet();
  return Menu.buildFromTemplate([
    { label: 'Open tasks', click: () => openPanel('tasks') },
    { label: 'Build a new pet…', click: () => openPanel('build') },
    { label: 'Switch pet', submenu: pets.length ? pets.map(p => ({ label: p.displayName, type: 'radio', checked: !!cur && p.id === cur.id, click: () => setPet(p.id) })) : [{ label: 'No pets yet', enabled: false }] },
    { label: 'Open T3 Code', click: focusT3 },
    { type: 'separator' },
    { label: petVisible() ? 'Hide pet' : 'Show pet', click: togglePet },
    { label: 'Bring pet back', click: resetPet },
    { label: Date.now() < mutedUntil ? 'Unmute notifications' : 'Mute notifications for 1 hour', click: () => {
      mutedUntil = Date.now() < mutedUntil ? 0 : Date.now() + 3600e3;
      tray.setContextMenu(trayMenu());
      if (mutedUntil) setTimeout(() => { if (tray && Date.now() >= mutedUntil) tray.setContextMenu(trayMenu()); }, 3600e3 + 1000);
    } },
    { label: 'Settings', click: () => openPanel('settings') },
    { type: 'separator' },
    { label: 'Quit T3 Pet', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}
function updateTray(mood) {
  if (tray) tray.setToolTip(`T3 Pet: ${mood.label}${petVisible() ? '' : ' (pet hidden: right-click for Show pet)'}`);
}
function petVisible() {
  return !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
}
function setPetVisible(show, source = 'unknown') {
  petLog(show ? 'show pet' : 'hide pet', `(from ${source})`);
  if (show) {
    if (!petWin || petWin.isDestroyed()) createPetWindow();
    else { petWin.showInactive(); ensurePetOnTop('shown'); }
  } else if (petWin && !petWin.isDestroyed()) {
    petWin.hide();
  }
  settings.petHidden = !show;
  saveSettings();
  if (tray) tray.setContextMenu(trayMenu());
  send(panelWin, 'pet:visibility', { visible: show });
}
function togglePet() {
  setPetVisible(!petVisible(), 'tray menu');
}
/** Move the pet back to the bottom-right corner of the primary screen, rebuild its window, and show it. */
function resetPet() {
  settings.position = null;
  settings.petPos = null;
  saveSettings();
  petLog('bring pet back');
  recreatePetWindow();
  setPetVisible(true, 'bring pet back');
}
/** Rebuild the pet window, e.g. after its renderer or the GPU process died (it would stay open but blank). */
function recreatePetWindow(reason = '') {
  if (reason) petLog('rebuild pet window', `(${reason})`);
  if (petWin && !petWin.isDestroyed()) {
    petWin.removeAllListeners('closed');
    petWin.destroy();
  }
  petWin = null;
  if (!settings.petHidden) createPetWindow();
}
function setPet(id) {
  settings.petId = id;
  saveSettings();
  send(petWin, 'pet:config', petConfig());
  send(panelWin, 'pet:config', petConfig());
  send(panelWin, 'pets:list', petsPayload());
  if (tray) tray.setContextMenu(trayMenu());
}

// ---------------- IPC ----------------
ipcMain.handle('pet:config', () => petConfig());
ipcMain.handle('tasks:get', () => ({ snapshot, mood: watcher.petMood(snapshot) }));
ipcMain.handle('tasks:refresh', async () => {
  await pollNow();
  return { snapshot, mood: watcher.petMood(snapshot) };
});
ipcMain.on('pet:mouse', (_e, capture) => { if (petWin) petWin.setIgnoreMouseEvents(!capture, { forward: true }); });
ipcMain.on('pet:drag', (_e, d) => {
  if (!petWin || !d || !Number.isFinite(d.dx) || !Number.isFinite(d.dy)) return;
  const p = currentPetPos();
  settings.petPos = { x: Math.round(p.x + d.dx), y: Math.round(p.y + d.dy) };
  applyPetLayout();
});
ipcMain.on('pet:dragEnd', () => {
  settings.petPos = currentPetPos();
  settings.position = null;
  saveSettings();
});
ipcMain.handle('pet:layout', () => petLayout().sprite);
ipcMain.on('pet:click', () => togglePanel('tasks'));
ipcMain.on('pet:menu', () => trayMenu().popup({ window: petWin }));
ipcMain.on('t3:focus', () => focusT3());
ipcMain.on('t3:get', () => shell.openExternal('https://github.com/pingdotgg/t3code').catch(() => {}));
ipcMain.on('t3:openThread', (_e, key) => { if (typeof key === 'string') openThread(key); });
ipcMain.on('panel:pin', (_e, pinned) => { panelPinned = !!pinned; });
ipcMain.on('panel:close', () => { if (panelWin) panelWin.hide(); });
ipcMain.handle('pet:visibility', () => ({ visible: petVisible() }));
ipcMain.handle('pet:setVisible', (_e, show, source) => { setPetVisible(!!show, typeof source === 'string' ? source.slice(0, 40) : 'panel'); return { visible: petVisible() }; });
ipcMain.handle('pet:reset', () => { resetPet(); return { visible: petVisible() }; });
ipcMain.handle('thread:action', async (_e, req) => {
  const { key, action } = req || {};
  try {
    await tasks.act(String(key), String(action));
    poll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, needsActions: e.code === 'actions_off' };
  }
});
ipcMain.handle('actions:enable', async () => {
  try { await t3.enableActions(); return { ok: true, settings: publicSettings() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('actions:disable', async () => {
  await t3.disableActions().catch(() => {});
  return publicSettings();
});

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return publicSettings();
  const allowed = ['motion', 'normalizeSize', 'scale', 'pollMs', 'remotePollMs', 'lookbackHours', 'dataSource', 'preciseLocalUnread', 'notify', 'sound', 'autoFallback', 'fallbackOrder', 'falModel', 'veniceEditModel', 'veniceModel', 'codexCmd', 'codexModel', 'pythonCmd', 'apiConcurrency', 't3DbPath', 't3App', 'openAtLogin'];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  saveSettings();
  if ('openAtLogin' in patch) setLoginItem(!!patch.openAtLogin);
  if (['pollMs', 't3DbPath', 'lookbackHours', 'dataSource'].some(k => k in patch)) startPolling();
  if (['scale', 'motion', 'normalizeSize'].some(k => k in patch)) send(petWin, 'pet:config', petConfig());
  if ('scale' in patch) applyPetLayout();
  return publicSettings();
});
ipcMain.handle('keys:set', (_e, { name, value }) => {
  if (!['fal', 'venice'].includes(name)) throw new Error('Unknown key');
  settings.keys = settings.keys || {};
  if (!value) delete settings.keys[name];
  else {
    const enc = encrypt(String(value).trim());
    if (!enc) throw new Error('This system has no OS encryption available, so the key was not saved.');
    settings.keys[name] = enc;
  }
  saveSettings();
  return publicSettings();
});
ipcMain.handle('pets:list', () => petsPayload());
ipcMain.handle('pets:set', (_e, id) => { setPet(String(id)); return petsPayload(); });
ipcMain.handle('pets:openFolder', () => { fs.mkdirSync(CODEX_PETS, { recursive: true }); return shell.openPath(CODEX_PETS); });
ipcMain.handle('builder:status', () => builder.status());
ipcMain.handle('builder:start', async (_e, req) => {
  builder.build(req).catch(err => builder.log('Error: ' + err.message));
  return builder.status();
});
ipcMain.handle('builder:cancel', () => { builder.cancel(); return builder.status(); });
ipcMain.handle('builder:pickReference', async () => {
  dialogOpen = true;
  try {
    const r = await dialog.showOpenDialog(panelWin, { title: 'Pick a reference image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    return r.canceled ? null : r.filePaths[0];
  } finally {
    dialogOpen = false;
  }
});
ipcMain.handle('file:open', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? shell.openPath(p) : null));
ipcMain.handle('file:url', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? pathToFileURL(p).href + '?v=' + Date.now() : null));

function setLoginItem(on) {
  if (IS_MAC && !app.isPackaged) {
    setMacDevLoginItem(on, { label: APP_ID, execPath: process.execPath, appPath: app.getAppPath(), envPath: process.env.PATH });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
}

// Windows shows toasts reliably for an unpackaged app only with a Start Menu shortcut carrying our app id.
function ensureWindowsShortcut() {
  if (!IS_WIN || app.isPackaged) return; // the installer creates its own shortcut with the same app id
  // A separate "(dev)" shortcut, so running from source never overwrites the installed app's shortcut.
  const lnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'T3 Pet (dev).lnk');
  try {
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      description: 'T3 Pet: desktop companion for T3 Code',
      icon: path.join(ASSETS, 'icon.ico'),
      iconIndex: 0,
      appUserModelId: APP_ID,
    });
  } catch {}
}

// Opening T3 Pet again (Start Menu, Spotlight) while it runs: bring the pet back and open the panel.
app.on('second-instance', () => {
  if (!petVisible()) setPetVisible(true, 'app opened again');
  openPanel('tasks');
});
// A GPU process crash can leave transparent windows blank: rebuild the pet window when it happens.
app.on('child-process-gone', (_e, d) => { if (d && d.type === 'GPU') setTimeout(() => recreatePetWindow('GPU process gone: ' + d.reason), 800); });
app.on('window-all-closed', () => { /* keep running in the tray */ });

app.whenReady().then(() => {
  if (IS_MAC && app.dock) app.dock.hide();
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  ensureWindowsShortcut();
  tray = new Tray(trayImage());
  tray.setContextMenu(trayMenu());
  if (!IS_MAC) tray.on('click', () => togglePanel('tasks'));
  if (!settings.petHidden) createPetWindow();
  // Screens added, removed or resized: keep the pet (and its bubble) on a visible screen.
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => applyPetLayout());
  // Safety net: Windows can drop always-on-top (showInactive, sleep, full-screen apps). Check and repair.
  setInterval(() => ensurePetOnTop('check'), 5000);
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(() => ensurePetOnTop('shown'), 1000));
  petLog('app started', `(v${app.getVersion()}, pet ${settings.petHidden ? 'hidden' : 'shown'})`);
  startPolling();
  // `--panel` or `--panel=<tasks|pets|build|settings>` opens the panel at start (handy while developing).
  // `--test-notification` shows one sample notification (to check OS notification permissions).
  if (process.argv.includes('--test-notification')) setTimeout(() => toast('T3 Pet test notification', 'If you can read this, notifications work.'), 1500);
  const panelArg = process.argv.find(a => a === '--panel' || a.startsWith('--panel='));
  if (panelArg) setTimeout(() => openPanel(panelArg.split('=')[1] || 'tasks'), 600);
});
