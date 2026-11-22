const $ = s => document.querySelector(s);
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ico = name => window.ICONS[name] || '';
const THIS_MACHINE = window.pet.platform === 'darwin' ? 'This Mac' : 'This PC';
const params = new URLSearchParams(location.search);
if ((params.get('platform') || window.pet.platform) === 'darwin') document.body.classList.add('mac');

// ---------- header ----------
$('#openT3').innerHTML = ico('external');
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
for (const [id, name] of [['#icoLink', 'link'], ['#icoShield', 'shield'], ['#icoBell', 'bell'], ['#icoPaw', 'paw'], ['#icoKey', 'key']]) $(id).innerHTML = ico(name);
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

function taskHtml(t, multiEnv) {
  const icon = ico(STATE_ICON[t.state] || 'dot');
  const iconCls = t.state === 'running' ? 'pulse' : (t.state === 'waiting' || t.state === 'needs-reply') ? 'pulse' : '';
  const machine = multiEnv ? `<span class="machine" title="${esc(t.isLocal ? 'This computer' : 'Linked: ' + t.envLabel)}">${ico('monitor')}${esc(t.isLocal ? THIS_MACHINE : t.envLabel)}</span>` : '';
  // Only offer what T3 accepts for this state: a running thread has no finished run to settle or mark unread.
  const finished = ['done', 'stopped', 'failed', 'needs-reply', 'idle'].includes(t.state);
  const acts = [
    ['open', 'external', 'Open in T3'],
    ...(finished ? [['settle', 'check', 'Settle (mark as handled)'], ['mark_unread', 'unread', 'Mark unread']] : []),
    ['snooze', 'snooze', 'Snooze for 1 hour'],
    ...(['done', 'stopped', 'failed', 'needs-reply'].includes(t.state) ? [['dismiss', 'eyeOff', 'Hide from the pet until it changes']] : []),
  ];
  return `<div class="task ${t.state}" data-key="${esc(t.key)}" tabindex="0" title="Open in T3">
    <div class="ic ${iconCls}">${icon}</div>
    <div class="body">
      <div class="t">${esc(t.title)}</div>
      <div class="meta"><span>${LABEL[t.state]}</span>${t.project ? `<span>· ${esc(t.project)}</span>` : ''}<span>· ${ago(t.completedAt || t.updatedAt)}</span>${machine}</div>
      ${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ''}
      ${stepsHtml(t.steps)}
    </div>
    <div class="hover-actions">${acts.map(([a, i, title]) => `<button data-act="${a}" title="${title}">${ico(i)}</button>`).join('')}</div>
  </div>`;
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
    : "Can't reach T3";
  const badge = $('#navBadge');
  badge.hidden = !need;
  badge.textContent = need;

  const notice = $('#notice');
  notice.hidden = !(snap.notice || !snap.ok || envs.some(e => e.status === 'error'));
  notice.textContent = !snap.ok ? snap.error : snap.notice || envs.filter(e => e.status === 'error').map(e => `Can't reach ${e.label} right now.`).join(' ');

  const chips = GROUPS.map(g => {
    const n = g.states.reduce((s, st) => s + (c[st] || 0), 0);
    return n ? `<span class="chip ${g.chip} ${filter === g.name ? 'active' : ''}" data-filter="${g.name}"><span class="d"></span>${g.name}<b>${n}</b></span>` : '';
  }).join('');
  $('#chips').innerHTML = chips;
  $('#chips').hidden = !chips;

  const threads = snap.threads || [];
  const active = threads.filter(t => t.state !== 'idle');
  const quiet = threads.filter(t => t.state === 'idle');
  let html = '';
  for (const g of GROUPS) {
    if (filter && filter !== g.name) continue;
    const list = active.filter(t => g.states.includes(t.state));
    if (!list.length) continue;
    html += `<div class="group-head">${g.name}<span class="n">${list.length}</span></div>` + list.map(t => taskHtml(t, multiEnv)).join('');
  }
  $('#taskList').innerHTML = html;
  $('#empty').hidden = !!active.length || !snap.ok;
  $('#quiet').hidden = !quiet.length;
  $('#quietCount').textContent = quiet.length;
  $('#quietList').innerHTML = quiet.slice(0, 30).map(t => taskHtml(t, multiEnv)).join('');
  const src = snap.source === 'database' ? "this computer's T3 database" : 'T3';
  $('#foot').textContent = snap.ok ? `Updated ${new Date(snap.at).toLocaleTimeString()} from ${src}.` : '';
  $('#actionsBanner').hidden = !actionsHint;
}

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
async function doAction(key, act, cardEl) {
  if (act === 'open') return window.pet.openThread(key);
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
}
function renderConnection() {
  const snap = last && last.snapshot;
  const envs = (snap && snap.environments) || [];
  $('#connInfo').innerHTML = !snap
    ? 'Connecting to T3…'
    : snap.ok
      ? envs.map(e => `<div class="connrow"><span class="d ${e.status !== 'reachable' ? 'off' : ''}"></span>${esc(e.isLocal ? `${e.label} (this computer)` : `${e.label} (linked)`)}</div>`).join('') +
        `<div class="small" style="margin-top:6px">${snap.source === 'database' ? "Reading this computer's T3 database (linked machines are not visible in this mode)." : 'Reading T3 through its tools with a read-only sign-in named “T3 Pet (read-only)”.'}</div>`
      : esc(snap.error || 'T3 Code is not running.');
}
window.pet.onTasks(() => { if (!document.querySelector('[data-view="settings"]').hidden) renderConnection(); });
async function save(patch) {
  S = await window.pet.setSettings(patch);
  $('#saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
}
for (const k of TEXT) $('#' + k).addEventListener('change', e => save({ [k]: e.target.value.trim() }));
for (const k of NUM) $('#' + k).addEventListener('change', e => save({ [k]: Number(e.target.value) }));
$('#dataSource').addEventListener('change', e => save({ dataSource: e.target.value }));
$('#scale').addEventListener('input', e => save({ scale: Number(e.target.value) }));
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
