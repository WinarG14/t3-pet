const $ = s => document.querySelector(s);
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ico = name => window.ICONS[name] || '';
const THIS_MACHINE = window.pet.platform === 'darwin' ? 'This Mac' : 'This PC';
const params = new URLSearchParams(location.search);
if ((params.get('platform') || window.pet.platform) === 'darwin') document.body.classList.add('mac');

// ---------- header ----------
$('#openT3').innerHTML = ico('external');
// show / hide the pet from the panel (also in the tray menu)
let petShown = true;
function applyPetVisibility(v) {
  petShown = !!v.visible;
  $('#petBtn').innerHTML = ico(petShown ? 'paw' : 'eyeOff');
  $('#petBtn').title = petShown ? 'Hide the pet' : 'Show the pet';
  $('#petBtn').classList.toggle('on', !petShown);
  if ($('#showPet')) $('#showPet').checked = petShown;
}
$('#petBtn').addEventListener('click', async () => {
  applyPetVisibility(await window.pet.setPetVisible(!petShown, 'panel paw button'));
  if (!petShown && window.say) window.say('Pet hidden. Click the paw (or the tray menu → Show pet) to bring it back.', 'info');
});
window.pet.onPetVisibility(applyPetVisibility);
window.pet.petVisibility().then(applyPetVisibility);
$('#pinBtn').innerHTML = ico('pin');
$('#closeBtn').innerHTML = ico('close');
let pinned = false;
$('#pinBtn').addEventListener('click', () => {
  pinned = !pinned;
  window.pet.pin(pinned);
  $('#pinBtn').innerHTML = ico(pinned ? 'pinned' : 'pin');
  $('#pinBtn').classList.toggle('on', pinned);
  $('#pinBtn').title = pinned ? 'Unpin (close when I click elsewhere)' : 'Keep this panel open';
});
$('#closeBtn').addEventListener('click', () => window.pet.close());
$('#openT3').addEventListener('click', () => window.pet.focusT3());
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.pet.close(); });
for (const [id, name] of [['#icoBellOff', 'bellOff'], ['#icoLink', 'link'], ['#icoShield', 'shield'], ['#icoBell', 'bell'], ['#icoPaw', 'paw'], ['#icoKey', 'key']]) $(id).innerHTML = ico(name);
$('#openPets').innerHTML = ico('folder') + 'Open folder';
document.querySelector('.ref-icon').innerHTML = ico('image');
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = ico(el.dataset.icon);

let atlas = null;
let petCfg = null;
let avatar = null;
let emptyPet = null;
function applyPet(cfg) {
  petCfg = cfg;
  atlas = cfg.atlas;
  $('#petName').textContent = cfg.pet ? cfg.pet.displayName : 'T3 Pet';
  if (avatar) avatar.stop();
  if (emptyPet) emptyPet.stop();
  avatar = emptyPet = null;
  if (cfg.pet) {
    avatar = new MiniSprite($('#avatar'), { url: cfg.pet.dataUrl || cfg.pet.url, atlas, scale: 0.22 });
    avatar.play('idle', { rest: 2600 });
    emptyPet = new MiniSprite($('#emptyPet'), { url: cfg.pet.dataUrl || cfg.pet.url, atlas, scale: 0.55 });
    emptyPet.play('waving', { speed: 1.3, rest: 2400 });
  }
}
window.pet.config().then(applyPet);
window.pet.onConfig(applyPet);

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== name;
  if (name === 'pets') loadPets();
  if (name === 'settings') loadSettings();
  $('#views').scrollTop = 0;
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
window.pet.onTab(showTab);
showTab(params.get('tab') || 'tasks');

// ---------- tasks ----------
const LABEL = { waiting: 'Needs your decision', 'needs-reply': 'Asking you', failed: 'Failed', running: 'Working', stale: 'Stalled', done: 'Finished', stopped: 'Stopped', idle: 'Quiet' };
const GROUPS = [
  { name: 'Needs you', states: ['waiting', 'needs-reply'], chip: 'need' },
  { name: 'Failed', states: ['failed'], chip: 'fail' },
  { name: 'Working', states: ['running', 'stale'], chip: 'run' },
  { name: 'Finished', states: ['done', 'stopped'], chip: 'done' },
];
const STATE_ICON = { waiting: 'hand', 'needs-reply': 'question', failed: 'x', running: 'bolt', stale: 'alert', done: 'checkCircle', stopped: 'stop', idle: 'dot' };
let filter = null;
let last = null;
let actionsHint = false;

function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function stepsHtml(steps) {
  if (!steps || !steps.length) return '';
  const done = steps.filter(s => s.status === 'completed').length;
  const cur = steps.find(s => s.status !== 'completed');
  return `<div class="steps"><div class="bar"><div style="width:${Math.round((done / steps.length) * 100)}%"></div></div>
    <div class="cur">${done}/${steps.length}${cur ? ' · ' + esc(cur.text) : ' · all steps done'}</div></div>`;
}

/** The parts of a task card. Kept separate so a refresh can update a card in place (see patchList). */
function taskParts(t, multiEnv) {
  const machine = multiEnv ? `<span class="machine">${ico('monitor')}${esc(t.isLocal ? THIS_MACHINE : t.envLabel)}</span>` : '';
  // Only offer what T3 accepts for this state: a running thread has no finished run to settle or mark unread.
  const finished = ['done', 'stopped', 'failed', 'needs-reply', 'idle'].includes(t.state);
  const acts = [
    ['open', 'external', 'Open in T3'],
    ['settle', 'check', finished ? 'Settle (mark as handled)' : 'Settle when this turn ends'],
    ...(finished ? [['mark_unread', 'unread', 'Mark unread']] : []),
    ['snooze', 'snooze', 'Snooze for 1 hour'],
    ...(t.state !== 'idle' && !t.muted ? [['dismiss', 'eyeOff', 'Hide from the pet until it changes']] : []),
    t.muted
      ? ['unmute', 'bell', `Unmute ${t.mutedBy === 'schedule' ? `schedule “${t.scheduleTitle}”` : `project “${t.project || 'this project'}”`}`]
      : ['mute', 'bellOff', t.scheduleKey ? `Mute schedule “${t.scheduleTitle}” (no notifications)` : `Mute project “${t.project || 'this project'}” (no notifications)`],
  ];
  return {
    cls: `task ${t.state}`,
    ic: `<div class="ic ${['running', 'waiting', 'needs-reply'].includes(t.state) ? 'pulse' : ''}">${ico(STATE_ICON[t.state] || 'dot')}</div>`,
    body: `<div class="t">${esc(t.title)}</div>
      <div class="meta">${t.muted ? '<span class="mtag">Muted</span>' : ''}<span>${LABEL[t.state]}</span>${t.project ? `<span>· ${esc(t.project)}</span>` : ''}<span>· ${ago(t.completedAt || t.updatedAt)}</span>${machine}</div>
      ${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ''}
      ${stepsHtml(t.steps)}`,
    acts: acts.map(([a, i, title]) => `<button data-act="${a}" title="${esc(title)}" aria-label="${esc(title)}">${ico(i)}</button>`).join(''),
  };
}

function makeTaskNode(key, parts) {
  const n = document.createElement('div');
  n.dataset.key = key;
  n.tabIndex = 0;
  n.innerHTML = `<div class="ic-slot"></div><div class="body"></div><div class="hover-actions"></div>`;
  return n;
}

/** Set only the parts that changed, so the node under the mouse keeps its hover state (no flicker). */
function updateTaskNode(n, parts) {
  if (n.className !== parts.cls) n.className = parts.cls;
  const slot = n.querySelector('.ic-slot');
  if (slot._h !== parts.ic) { slot.innerHTML = parts.ic; slot._h = parts.ic; }
  const body = n.querySelector('.body');
  if (body._h !== parts.body) { body.innerHTML = parts.body; body._h = parts.body; }
  const acts = n.querySelector('.hover-actions');
  if (acts._h !== parts.acts) { acts.innerHTML = parts.acts; acts._h = parts.acts; }
}

/**
 * Keyed list update. items: [{ id, kind: 'head'|'task', html?, parts?, key? }]. Existing nodes are reused
 * and only changed parts are touched; nodes are moved, not recreated, when the order changes.
 */
function patchList(container, items) {
  const existing = new Map();
  for (const n of [...container.children]) if (n._rid) existing.set(n._rid, n);
  let prev = null;
  for (const it of items) {
    let n = existing.get(it.id);
    existing.delete(it.id);
    if (it.kind === 'head') {
      if (!n) { n = document.createElement('div'); n.className = 'group-head'; n._rid = it.id; }
      if (n._h !== it.html) { n.innerHTML = it.html; n._h = it.html; }
    } else {
      if (!n) { n = makeTaskNode(it.key); n._rid = it.id; }
      updateTaskNode(n, it.parts);
    }
    const want = prev ? prev.nextSibling : container.firstChild;
    if (n !== want) container.insertBefore(n, want);
    prev = n;
  }
  for (const n of existing.values()) n.remove();
}

function render() {
  const p = last;
  if (!p || !p.snapshot) return;
  const snap = p.snapshot;
  const c = snap.counts || {};
  const need = (c.waiting || 0) + (c['needs-reply'] || 0);
  const envs = snap.environments || [];
  const multiEnv = envs.length > 1;
  $('#moodLine').textContent = snap.ok
    ? `${p.mood.label}${multiEnv ? ` · ${envs.length} machines` : ''}`
    : (snap.problem ? p.mood.label : "Can't reach T3");
  const badge = $('#navBadge');
  badge.hidden = !need;
  badge.textContent = need;

  const notice = $('#notice');
  const html = setupHtml(snap);
  notice.hidden = !html;
  if (notice._h !== html) { notice.innerHTML = html; notice._h = html; }

  const chips = GROUPS.map(g => {
    const n = g.states.reduce((s, st) => s + (c[st] || 0), 0);
    return n ? `<span class="chip ${g.chip} ${filter === g.name ? 'active' : ''}" data-filter="${g.name}"><span class="d"></span>${g.name}<b>${n}</b></span>` : '';
  }).join('');
  if ($('#chips')._h !== chips) { $('#chips').innerHTML = chips; $('#chips')._h = chips; }
  $('#chips').hidden = !chips;

  const threads = snap.threads || [];
  const active = threads.filter(t => t.state !== 'idle' && !t.muted);
  // A filter whose group just emptied has no chip left to click: clear it instead of showing a blank list.
  if (filter && !active.some(t => (GROUPS.find(g => g.name === filter) || { states: [] }).states.includes(t.state))) filter = null;
  const quiet = threads.filter(t => t.state === 'idle' || t.muted);
  const items = [];
  for (const g of GROUPS) {
    if (filter && filter !== g.name) continue;
    const list = active.filter(t => g.states.includes(t.state));
    if (!list.length) continue;
    items.push({ id: 'g:' + g.name, kind: 'head', html: `${g.name}<span class="n">${list.length}</span>` });
    for (const t of list) items.push({ id: 't:' + t.key, kind: 'task', key: t.key, parts: taskParts(t, multiEnv) });
  }
  patchList($('#taskList'), items);
  $('#empty').hidden = !!active.length || !snap.ok;
  $('#quiet').hidden = !quiet.length;
  $('#quietCount').textContent = quiet.length;
  patchList($('#quietList'), quiet.slice(0, 30).map(t => ({ id: 't:' + t.key, kind: 'task', key: t.key, parts: taskParts(t, multiEnv) })));
  const src = snap.source === 'database' ? "this computer's T3 database" : 'T3';
  $('#foot').textContent = snap.ok ? `Updated ${new Date(snap.at).toLocaleTimeString()} from ${src}.` : '';
  $('#actionsBanner').hidden = !actionsHint;
}

/** What is wrong with the connection, in plain words, with the buttons that fix it. '' when all is well. */
function setupHtml(snap) {
  const envs = snap.environments || [];
  const down = envs.filter(e => !e.isLocal && (e.status === 'error' || (e.status && e.status !== 'reachable')));
  const pr = snap.problem;
  let text = '';
  if (pr) text = pr.code === 'not-running' ? (snap.ok ? `${pr.text} Showing this computer's threads only.` : `${pr.text} ${snap.error || ''}`.trim()) : pr.text;
  else if (!snap.ok) text = snap.error || "T3 Pet can't read T3.";
  else if (snap.notice) text = snap.notice;
  const lines = down.map(e => `Can't reach ${esc(e.label)}${e.error ? `: ${esc(e.error)}` : ''}. Check that it is on and that T3 Code runs there.`);
  if (!text && !lines.length) return '';
  const btns = [];
  if (pr && pr.code === 'not-installed') btns.push('<button class="btn primary small" data-setup="getT3">Get T3 Code</button>');
  else if (pr || down.length || !snap.ok) btns.push('<button class="btn primary small" data-setup="openT3">Open T3 Code</button>');
  if (pr || down.length || !snap.ok) btns.push('<button class="btn ghost small" data-setup="retry">Check again</button>');
  return `${text ? `<div>${esc(text)}</div>` : ''}${lines.map(l => `<div>${l}</div>`).join('')}${btns.length ? `<div class="row-end">${btns.join('')}</div>` : ''}`;
}
async function setupAction(btn) {
  const what = btn.dataset.setup;
  if (what === 'openT3') return window.pet.focusT3();
  if (what === 'getT3') return window.pet.getT3();
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const p = await window.pet.refresh();
    if (p && p.snapshot) { last = p; render(); if (!document.querySelector('[data-view="settings"]').hidden) renderConnection(); }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check again';
  }
}
document.addEventListener('click', e => { const b = e.target.closest('[data-setup]'); if (b) setupAction(b); });

window.pet.onTasks(p => { last = p; render(); });
window.pet.tasks().then(p => { if (p && p.snapshot) { last = p; render(); } });
setInterval(render, 30000);

$('#chips').addEventListener('click', e => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  filter = filter === chip.dataset.filter ? null : chip.dataset.filter;
  render();
});

// In-panel messages. Never use alert(): a native dialog takes focus and the popover hides itself.
let toastTimer = null;
function say(text, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.querySelector('.shell').appendChild(el);
  }
  el.textContent = text;
  el.className = `toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}
window.say = say;

const DONE_TEXT = { settle: 'Settled', mark_unread: 'Marked unread', snooze: 'Snoozed for 1 hour', dismiss: 'Hidden until it changes' };
// ---------- muting (Settings > Muted projects and schedules, and the bell button on a task) ----------
function isMuted(kind, key) {
  return !!(S && S.muted && (S.muted[kind] || []).includes(key));
}
async function setMuted(kind, key, on) {
  if (!S) S = await window.pet.settings();
  const m = { projects: [...((S.muted && S.muted.projects) || [])], schedules: [...((S.muted && S.muted.schedules) || [])] };
  m[kind] = on ? [...new Set([...m[kind], key])] : m[kind].filter(k => k !== key);
  await save({ muted: m });
  renderMuted(true);
}
async function muteAction(key, act) {
  const t = last && last.snapshot && (last.snapshot.threads || []).find(x => x.key === key);
  if (!t) return;
  if (act === 'mute') {
    if (t.scheduleKey) await setMuted('schedules', t.scheduleKey, true);
    else await setMuted('projects', t.projectKey, true);
    say(`Muted ${t.scheduleKey ? `“${t.scheduleTitle}”` : `“${t.project || 'this project'}”`}. It stays under Recent quiet threads; unmute it there or in Settings.`, 'ok');
  } else {
    if (t.mutedBy === 'schedule') await setMuted('schedules', t.scheduleKey, false);
    else await setMuted('projects', t.projectKey, false);
    say('Unmuted', 'ok');
  }
}
function every(ms) {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `every ${m} min`;
  if (m % 1440 === 0) return m === 1440 ? 'every day' : `every ${m / 1440} days`;
  return m % 60 ? `every ${(m / 60).toFixed(1)} h` : `every ${m / 60} h`;
}
function renderMuted(force) {
  const box = $('#mutedList');
  const snap = last && last.snapshot;
  const row = (kind, key, title, sub) => `<label class="switch mrow"><input type="checkbox" data-mute="${kind}" data-key="${esc(key)}" ${isMuted(kind, key) ? 'checked' : ''}><i></i><span title="${esc(title + (sub ? ' · ' + sub : ''))}"><span class="mt">${esc(title)}</span><span class="ms">${esc(sub)}</span></span></label>`;
  const scheds = (snap && snap.schedules) || [];
  const projects = (snap && snap.projects) || [];
  const html = !snap ? '<p class="muted small">Connecting to T3…</p>'
    : `<div class="mhead">Schedules</div>${scheds.length ? scheds.map(x => row('schedules', x.key, x.title, [every(x.everyMs), x.enabled ? '' : 'paused', x.project, x.envLabel].filter(Boolean).join(' · '))).join('') : `<p class="muted small">${snap.source === 'database' ? 'Schedules show when T3 Code runs.' : 'No scheduled tasks in T3.'}</p>`}
      <div class="mhead">Projects</div>${projects.length ? projects.map(x => row('projects', x.key, x.name, x.envLabel)).join('') : '<p class="muted small">No recent projects.</p>'}`;
  if (!force && box._h === html) return;
  box.innerHTML = html;
  box._h = html;
}
$('#mutedList').addEventListener('change', e => {
  const cb = e.target.closest('[data-mute]');
  if (cb) setMuted(cb.dataset.mute, cb.dataset.key, cb.checked);
});

async function doAction(key, act, cardEl) {
  if (act === 'open') return window.pet.openThread(key);
  if (act === 'mute' || act === 'unmute') return muteAction(key, act);
  if (cardEl) cardEl.style.opacity = '.55';
  const r = await window.pet.threadAction(key, act);
  if (cardEl) cardEl.style.opacity = '';
  if (!r.ok && r.needsActions) {
    actionsHint = true;
    render();
    return;
  }
  if (!r.ok) return say(r.error, 'error');
  say(DONE_TEXT[act] || 'Done', 'ok');
}

for (const list of ['#taskList', '#quietList']) {
  $(list).addEventListener('click', e => {
    const card = e.target.closest('[data-key]');
    if (!card) return;
    const btn = e.target.closest('[data-act]');
    if (btn) { e.stopPropagation(); doAction(card.dataset.key, btn.dataset.act, card); return; }
    window.pet.openThread(card.dataset.key);
  });
  $(list).addEventListener('keydown', e => {
    const card = e.target.closest('[data-key]');
    if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); window.pet.openThread(card.dataset.key); }
  });
}
$('#bannerLater').addEventListener('click', () => { actionsHint = false; render(); });
$('#bannerEnable').addEventListener('click', async () => {
  $('#bannerEnable').disabled = true;
  $('#bannerEnable').textContent = 'Turning on…';
  const r = await window.pet.enableActions();
  $('#bannerEnable').disabled = false;
  $('#bannerEnable').textContent = 'Turn on';
  if (!r.ok) return say(r.error, 'error');
  actionsHint = false;
  render();
});

// ---------- pets ----------
let petSprites = [];
async function loadPets(data) {
  const d = data || await window.pet.pets();
  for (const s of petSprites) s.stop();
  petSprites = [];
  const grid = $('#petGrid');
  grid.innerHTML = d.pets.map(p => `
    <div class="pet-card ${p.id === d.current ? 'current' : ''}" data-id="${esc(p.id)}" title="${esc(p.description)}">
      ${p.id === d.current ? '<span class="tag">Active</span>' : ''}
      <div class="stage"><div class="spr"></div></div>
      <div class="name">${esc(p.displayName)}</div>
    </div>`).join('') + `<div class="pet-card new" id="newPet">${ico('plus')}<div class="name">New pet</div></div>`;
  if (atlas) {
    grid.querySelectorAll('.pet-card[data-id]').forEach((card, i) => {
      const s = new MiniSprite(card.querySelector('.spr'), { url: d.pets[i].url, atlas, scale: 0.4 });
      petSprites.push(s);
      card.addEventListener('mouseenter', () => s.play('waving', { speed: 1.1, rest: 600 }));
      card.addEventListener('mouseleave', () => { s.stop(); s.frame(0, 'idle'); });
      card.addEventListener('click', async () => loadPets(await window.pet.setPet(card.dataset.id)));
    });
  }
  $('#newPet').addEventListener('click', () => showTab('build'));
}
window.pet.onPets(loadPets);
$('#openPets').addEventListener('click', () => window.pet.openPetsFolder());

// ---------- build ----------
let reference = null;
let style = 'auto';
$('#styleSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  style = b.dataset.v;
  for (const x of $('#styleSeg').children) x.classList.toggle('on', x === b);
});
$('#pickRef').addEventListener('click', async () => {
  const p = await window.pet.pickReference();
  if (p) { reference = p; $('#refName').textContent = p.split(/[\\/]/).pop(); $('#clearRef').hidden = false; }
});
$('#clearRef').addEventListener('click', () => { reference = null; $('#refName').textContent = 'Reference image'; $('#clearRef').hidden = true; });
$('#buildForm').addEventListener('submit', async e => {
  e.preventDefault();
  const req = Object.fromEntries(new FormData(e.target).entries());
  req.reference = reference;
  req.style = style;
  if (!req.notes && !req.description && !reference) return say('Describe the pet or choose a reference image.', 'error');
  renderBuilder(await window.pet.build(req));
});
$('#cancelBtn').addEventListener('click', async () => renderBuilder(await window.pet.cancelBuild()));

async function renderBuilder(st) {
  if (!st) return;
  const started = st.active || st.result || (st.log && st.log.length);
  $('#buildStatus').hidden = !started;
  $('#buildBtn').disabled = !!st.active;
  $('#cancelBtn').hidden = !st.active;
  $('#bStep').textContent = st.step || '';
  $('#bSpin').classList.toggle('stop', !st.active);
  $('#bProv').textContent = st.provider ? `Engine: ${st.provider}` : '';
  const pct = st.result && st.result.ok ? 100 : st.jobsTotal ? Math.round(((st.jobsDone || 0) / st.jobsTotal) * 100) : (st.active ? 6 : 0);
  $('#bBar').style.width = pct + '%';
  const log = $('#bLog');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = (st.log || []).join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
  const r = st.result;
  if (r && r.ok) {
    const url = r.contactSheet ? await window.pet.fileUrl(r.contactSheet) : null;
    $('#bResult').innerHTML = `<p><strong>${esc(r.petId)}</strong> hatched with ${esc(r.provider)}. <button class="btn ghost small" id="usePet">Use it now</button></p>${url ? `<img alt="Every pose of the new pet" src="${url}">` : ''}`;
    $('#usePet').addEventListener('click', () => window.pet.setPet(r.petId));
  } else if (r && !r.ok) {
    $('#bResult').innerHTML = `<p style="color:var(--fail)">${esc(r.error)}</p>`;
  } else {
    $('#bResult').innerHTML = '';
  }
}
window.pet.onBuilder(renderBuilder);
window.pet.builderStatus().then(renderBuilder);

// ---------- settings ----------
const TEXT = ['falModel', 'veniceEditModel', 'veniceModel', 'pythonCmd', 'codexModel', 't3App'];
const NUM = ['pollMs', 'remotePollMs', 'lookbackHours'];
let S = null;
window.pet.settings().then(v => { if (!S) S = v; }); // the bell button on tasks reads the mute list
async function loadSettings() {
  S = await window.pet.settings();
  for (const k of TEXT) $('#' + k).value = S[k] || '';
  for (const k of NUM) $('#' + k).value = S[k];
  $('#dataSource').value = S.dataSource || 'auto';
  $('#scale').value = S.scale;
  $('#sound').checked = !!S.sound;
  $('#autoFallback').checked = !!S.autoFallback;
  $('#openAtLogin').checked = !!S.openAtLogin;
  $('#normalizeSize').checked = S.normalizeSize !== false;
  for (const b of $('#motionSeg').children) b.classList.toggle('on', b.dataset.v === (S.motion || 'calm'));
  for (const el of document.querySelectorAll('[data-notify]')) el.checked = !!S.notify[el.dataset.notify];
  for (const k of ['fal', 'venice']) {
    const el = $('#' + k + 'State');
    el.textContent = S.keysSet[k] ? 'saved' : 'not set';
    el.className = 'keystate' + (S.keysSet[k] ? ' set' : '');
  }
  const row = $('#actionsRow');
  row.innerHTML = S.actions.enabled
    ? `<span class="muted small" style="margin-right:auto;align-self:center">On until ${new Date(S.actions.expiresAt).toLocaleDateString()}</span><button class="btn ghost small" id="actOff">Turn off</button>`
    : `<button class="btn primary small" id="actOn">${ico('shield')}Turn on</button>`;
  if ($('#actOn')) $('#actOn').addEventListener('click', async () => {
    $('#actOn').disabled = true;
    const r = await window.pet.enableActions();
    if (!r.ok) say(r.error, 'error');
    loadSettings();
  });
  if ($('#actOff')) $('#actOff').addEventListener('click', async () => { await window.pet.disableActions(); loadSettings(); });
  renderConnection();
  renderMuted(true);
}
function renderConnection() {
  const snap = last && last.snapshot;
  const envs = (snap && snap.environments) || [];
  const rows = !snap ? '<div>Connecting to T3…</div>'
    : envs.map(e => {
      const off = e.status !== 'reachable';
      const why = off ? ` <span class="why">${esc(e.error || e.status || 'not reachable')}</span>` : '';
      return `<div class="connrow"><span class="d ${off ? 'off' : ''}"></span><span>${esc(e.isLocal ? `${e.label} (this computer)` : `${e.label} (linked)`)}${why}</span></div>`;
    }).join('');
  const how = !snap ? '' : snap.source === 'database'
    ? (snap.problem ? esc(snap.problem.text) : !snap.ok ? esc(snap.error || "T3 Pet can't read T3.") : "Reading this computer's T3 database (linked machines are not visible in this mode).")
    : 'Reading T3 through its tools with a read-only sign-in named “T3 Pet (read-only)”.';
  const getOrOpen = snap && snap.problem && snap.problem.code === 'not-installed'
    ? '<button class="btn primary small" data-setup="getT3">Get T3 Code</button>'
    : '<button class="btn ghost small" data-setup="openT3">Open T3 Code</button>';
  const conn = $('#connInfo');
  const html = `${rows}<div class="small" style="margin-top:6px">${how}</div>
    <div class="row-end" style="justify-content:flex-start">${getOrOpen}<button class="btn ghost small" data-setup="retry">Check again</button></div>
    <details class="howto"><summary>Add another machine</summary><ol>
      <li>On each machine, open T3 Code → Settings → Labs and turn on <b>Linked environments</b>.</li>
      <li>On this computer, open T3 Code → Settings → Connections and link the other machine.</li>
      <li>That's all. T3 Pet shows the new machine here within about a minute, or at once when you click Check again. It needs no set-up of its own.</li>
    </ol></details>`;
  if (conn._h === html) return; // unchanged: keep the open "Add another machine" box and button states
  const open = !!(conn.querySelector('.howto') || {}).open;
  conn.innerHTML = html;
  conn._h = html;
  if (open) conn.querySelector('.howto').open = true;
}
window.pet.onTasks(() => { if (!document.querySelector('[data-view="settings"]').hidden) { renderConnection(); renderMuted(); } });
async function save(patch) {
  S = await window.pet.setSettings(patch);
  $('#saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
}
for (const k of TEXT) $('#' + k).addEventListener('change', e => save({ [k]: e.target.value.trim() }));
for (const k of NUM) $('#' + k).addEventListener('change', e => save({ [k]: Number(e.target.value) }));
$('#dataSource').addEventListener('change', e => save({ dataSource: e.target.value }));
$('#scale').addEventListener('input', e => save({ scale: Number(e.target.value) }));
$('#showPet').addEventListener('change', async e => applyPetVisibility(await window.pet.setPetVisible(e.target.checked, 'settings switch')));
$('#resetPet').addEventListener('click', async () => { applyPetVisibility(await window.pet.resetPet()); say('The pet is back in the bottom-right corner.', 'ok'); });
for (const id of ['sound', 'autoFallback', 'openAtLogin', 'normalizeSize']) $('#' + id).addEventListener('change', e => save({ [id]: e.target.checked }));
$('#motionSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  for (const x of $('#motionSeg').children) x.classList.toggle('on', x === b);
  save({ motion: b.dataset.v });
});
for (const el of document.querySelectorAll('[data-notify]')) {
  el.addEventListener('change', () => save({ notify: { ...S.notify, [el.dataset.notify]: el.checked } }));
}
for (const b of document.querySelectorAll('[data-savekey]')) {
  b.addEventListener('click', async () => {
    const name = b.dataset.savekey;
    const input = $('#' + name + 'Key');
    if (!input.value.trim()) return;
    try { await window.pet.setKey(name, input.value); input.value = ''; await loadSettings(); $('#saved').textContent = `${name.toUpperCase()} key saved (encrypted).`; }
    catch (err) { say(err.message, 'error'); }
  });
}
for (const b of document.querySelectorAll('[data-clearkey]')) {
  b.addEventListener('click', async () => { await window.pet.setKey(b.dataset.clearkey, ''); loadSettings(); });
}
