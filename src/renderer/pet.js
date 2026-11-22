// Pet window: plays a Codex pet atlas, shows a speech bubble and a badge, handles drag and click.
const sprite = document.getElementById('sprite');
const bubble = document.getElementById('bubble');
const badge = document.getElementById('badge');

let cfg = null;
let mood = { anim: 'idle', label: '' };
let snapshot = null;
let rowScale = {};          // state -> size correction so every row looks the same size as idle
let override = null;        // { state, loops } for one-off reactions (jump, wave, drag)
let current = null;
let frame = 0;
let holding = false;
let frameTimer = null;
let bubbleTimer = null;
let hovering = false;
let lastWave = Date.now();

// How each activity looks. "calm" (default): play the row slowly once, then hold its last pose.
// The atlas row names are the Codex pet contract; the mapping is ours.
const CALM = {
  idle:    { row: 'idle',    speed: 1.5, holdMs: 3500 },
  running: { row: 'review',  speed: 1.5, holdMs: 2500 },   // focused work, not the busy "running" row
  waiting: { row: 'waiting', speed: 1.3, holdMs: 1800 },   // asking pose: needs your decision
  failed:  { row: 'failed',  speed: 1.3, holdMs: 7000 },   // sad, then stays sad
  review:  { row: 'idle',    speed: 1.5, holdMs: 3500, waveEveryMs: 45000 }, // finished, unread
};
const LIVELY = {
  idle: { row: 'idle', speed: 1 }, running: { row: 'running', speed: 1 }, waiting: { row: 'waiting', speed: 1 },
  failed: { row: 'failed', speed: 1 }, review: { row: 'review', speed: 1 },
};
const REACTION = { speed: 1.15 };   // jump / wave / drag play once at near-normal speed

function plan() {
  if (override) return { row: override.state, speed: override.speed || REACTION.speed, holdMs: 0 };
  const table = cfg && cfg.motion === 'lively' ? LIVELY : CALM;
  return table[mood.anim] || table.idle;
}

// ---------- size normalisation ----------
// Generated rows often draw the pet at different sizes (a walking pose fills the cell, a sitting pose
// does not). Measure the opaque area of each row and scale rows to match the idle row.
function measureRows(dataUrl, atlas) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = atlas.width; c.height = atlas.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const areas = {};
        for (const [state, st] of Object.entries(atlas.states)) {
          const counts = [];
          for (let f = 0; f < st.durations.length; f++) {
            const d = ctx.getImageData(f * atlas.cellWidth, st.row * atlas.cellHeight, atlas.cellWidth, atlas.cellHeight).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
            if (n > 50) counts.push(n);
          }
          counts.sort((a, b) => a - b);
          areas[state] = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
        }
        const base = areas.idle || 0;
        const out = {};
        for (const s of Object.keys(areas)) {
          out[s] = base && areas[s] ? Math.min(1.1, Math.max(0.55, Math.sqrt(base / areas[s]))) : 1;
        }
        resolve(out);
      } catch {
        resolve({});
      }
    };
    img.onerror = () => resolve({});
    img.src = dataUrl;
  });
}

async function applyConfig(c) {
  cfg = c;
  if (!cfg.pet) {
    sprite.className = 'nopet';
    sprite.style.cssText = '';
    return;
  }
  const s = cfg.scale || 0.6;
  const a = cfg.atlas;
  sprite.className = '';
  sprite.style.width = Math.round(a.cellWidth * s) + 'px';
  sprite.style.height = Math.round(a.cellHeight * s) + 'px';
  sprite.style.backgroundImage = `url("${cfg.pet.dataUrl || cfg.pet.url}")`;
  sprite.style.backgroundSize = `${a.width * s}px auto`; // auto height: 8x9 and 8x11 (v2) sheets both keep their aspect
  rowScale = cfg.normalizeSize === false ? {} : await measureRows(cfg.pet.dataUrl || cfg.pet.url, a);
  restart();
}

function drawFrame() {
  if (!cfg || !cfg.pet) return;
  const a = cfg.atlas;
  const st = a.states[current] || a.states.idle;
  const s = cfg.scale || 0.6;
  sprite.style.backgroundPosition = `${-frame * a.cellWidth * s}px ${-st.row * a.cellHeight * s}px`;
  sprite.style.transform = `scale(${rowScale[current] || 1})`;
}

function tick() {
  if (!cfg || !cfg.pet) return;
  const p = plan();
  const st = cfg.atlas.states[current] || cfg.atlas.states.idle;
  if (holding) {
    // Rest on the last pose, then play the row again (or switch to a new mood).
    frameTimer = setTimeout(() => {
      holding = false;
      frame = 0;
      next();
    }, p.holdMs || 0);
    return;
  }
  frameTimer = setTimeout(() => {
    frame += 1;
    if (frame >= st.durations.length) {
      if (override) {
        override.loops = (override.loops || 1) - 1;
        if (override.loops <= 0 && !override.sticky) override = null;
        frame = 0;
        return next();
      }
      if (p.holdMs) {
        frame = st.durations.length - 1;
        holding = true;
        drawFrame();
        return tick();
      }
      frame = 0;
      return next();
    }
    drawFrame();
    tick();
  }, (st.durations[frame] || 150) * (p.speed || 1));
}

function next() {
  const p = plan();
  if (!override && p.waveEveryMs && Date.now() - lastWave > p.waveEveryMs) {
    lastWave = Date.now();
    override = { state: 'waving', loops: 1 };
  }
  current = plan().row;
  drawFrame();
  tick();
}

function restart() {
  clearTimeout(frameTimer);
  holding = false;
  frame = 0;
  current = plan().row;
  drawFrame();
  tick();
}

function react(state, loops = 1) {
  override = { state, loops };
  restart();
}

// ---------- bubble ----------
const LABEL = { waiting: 'Needs your decision', 'needs-reply': 'Asking you', failed: 'Failed', running: 'Working', stale: 'Stalled (T3 not running)', done: 'Finished', stopped: 'Stopped', idle: 'Quiet' };

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Quick actions on finished rows: settle (needs thread actions on) and hide from the pet.
// Every listed row gets them: T3 applies a settle on a running thread when its turn ends.
const QUICK = ['done', 'stopped', 'failed', 'needs-reply', 'running', 'stale', 'waiting'];
function rowHtml(key, state, title, detail, label, machine) {
  const icons = window.ICONS || {};
  const quick = QUICK.includes(state)
    ? `<div class="qa"><button data-act="settle" title="Settle">${icons.check || '✓'}</button><button data-act="dismiss" title="Hide until it changes">${icons.eyeOff || '×'}</button></div>`
    : '';
  return `<div class="row ${state}" data-thread="${esc(key)}"><span class="dot"></span><div class="txt">
      <span class="t">${esc(title)}</span>
      <span class="d">${esc(label)}${machine ? ' · ' + esc(machine) : ''}${detail ? ': ' + esc(detail) : ''}</span>
    </div>${quick}</div>`;
}

function renderSummary() {
  if (!snapshot) return '<div class="head">Looking for T3…</div>';
  if (!snapshot.ok) return `<div class="head">I can't read T3</div><div class="d">${esc(snapshot.error)}</div>`;
  const active = snapshot.threads.filter(t => t.state !== 'idle');
  if (!active.length) return `<div class="head"><span class="mood idle"></span>All caught up</div><div class="d solo">Nothing is running or waiting for you. Click me for the task list.</div>`;
  const multi = (snapshot.environments || []).length > 1;
  const rows = active.slice(0, 3).map(t => rowHtml(t.key || t.id, t.state, t.title, t.detail, LABEL[t.state], multi && !t.isLocal ? t.envLabel : '')).join('');
  const more = active.length > 3 ? `<div class="more">+${active.length - 3} more · click for all tasks</div>` : '';
  return `<div class="head"><span class="mood ${esc(mood.anim)}"></span>${esc(mood.label)}</div>${rows}${more}`;
}

/** Make `cur`'s children match `next`'s, reusing elements so hover state survives (no flicker). */
function morph(cur, next) {
  const a = [...cur.childNodes];
  const b = [...next.childNodes];
  for (let i = 0; i < b.length; i++) {
    const n = b[i];
    const c = a[i];
    if (!c) { cur.appendChild(n.cloneNode(true)); continue; }
    if (c.nodeType !== n.nodeType || c.nodeName !== n.nodeName || (c.dataset && n.dataset && c.dataset.thread !== n.dataset.thread)) {
      cur.replaceChild(n.cloneNode(true), c);
      continue;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      if (c.nodeValue !== n.nodeValue) c.nodeValue = n.nodeValue;
      continue;
    }
    if (c.isEqualNode(n)) continue;
    for (const { name, value } of [...n.attributes]) if (c.getAttribute(name) !== value) c.setAttribute(name, value);
    for (const { name } of [...c.attributes]) if (!n.hasAttribute(name)) c.removeAttribute(name);
    morph(c, n);
  }
  for (let i = a.length - 1; i >= b.length; i--) a[i].remove();
}

let bubbleHtml = '';
let noteTimer = null;
function showBubble(html, ms) {
  // Update in place only when the content changed: replacing it every refresh made the row under the mouse flicker.
  if (html !== bubbleHtml) {
    const t = document.createElement('template');
    t.innerHTML = html;
    morph(bubble, t.content);
    bubbleHtml = html;
  }
  positionBubble();
  bubble.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(() => { if (!hovering) bubble.classList.add('hidden'); }, ms);
}

// ---------- placement: where the pet sits in its window, and where the bubble fits ----------
let layout = null; // { x, y, w, h } of the pet inside this window, from the main process
const petwrapEl = document.getElementById('petwrap');
function applyLayout(l) {
  if (!l) return;
  layout = l;
  petwrapEl.style.left = `${l.x}px`;
  petwrapEl.style.top = `${l.y}px`;
  positionBubble();
}
/** Above the pet if it fits, else below; shifted sideways to stay inside the window; tail points at the pet. */
function positionBubble() {
  if (!layout) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bw = bubble.offsetWidth || 272;
  const bh = bubble.offsetHeight || 120;
  const gap = 10;
  const cx = layout.x + layout.w / 2;
  const spaceAbove = layout.y - gap;
  const spaceBelow = H - (layout.y + layout.h) - gap;
  const below = spaceAbove < bh + 4 && spaceBelow > spaceAbove;
  const top = below ? layout.y + layout.h + gap : Math.max(4, layout.y - gap - bh);
  const left = Math.min(Math.max(cx - bw * 0.78, 4), W - bw - 4);
  const tail = Math.min(Math.max(cx - left, 22), bw - 22);
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.setProperty('--tail-x', `${Math.round(tail)}px`);
  bubble.classList.toggle('below', below);
}
window.pet.onLayout(applyLayout);
window.pet.layout().then(applyLayout);

function hideBubbleSoon() {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { if (!hovering) bubble.classList.add('hidden'); }, 1200);
}

function updateBadge() {
  const c = (snapshot && snapshot.counts) || {};
  const need = (c.waiting || 0) + (c['needs-reply'] || 0);
  const fail = c.failed || 0;
  if (need) { badge.textContent = need; badge.className = ''; }
  else if (fail) { badge.textContent = '!'; badge.className = 'failed'; }
  else badge.className = 'hidden';
}

const EVENT_HEAD = { waiting: 'I need your decision', 'needs-reply': 'A task is asking you', failed: 'Something failed', done: 'A task finished' };

function onTasks(p) {
  const prevAnim = mood.anim;
  snapshot = p.snapshot;
  mood = p.mood;
  updateBadge();
  if (p.events && p.events.length) {
    const e = p.events[0];
    showBubble(`<div class="head">${esc(EVENT_HEAD[e.kind] || 'Update')}</div>
      ${rowHtml(e.key, e.kind, e.title, e.detail, 'Click to open', e.envLabel)}
      ${p.events.length > 1 ? `<div class="more">+${p.events.length - 1} more update(s)</div>` : ''}`, 9000);
    if (e.kind === 'done') react('jumping', 1);
    else if (e.kind === 'waiting' || e.kind === 'needs-reply') react('waving', 1);
    else if (e.kind === 'failed') react('failed', 1);
  } else if (hovering) {
    showBubble(renderSummary());
  }
  if (!override && mood.anim !== prevAnim) restart();
}

// ---------- mouse: capture only over the pet and bubble; drag; click ----------
for (const el of [sprite, bubble]) {
  el.addEventListener('mouseenter', () => {
    window.pet.mouse(true);
    hovering = true;
    if (el === sprite) showBubble(renderSummary());
  });
  el.addEventListener('mouseleave', () => {
    if (drag) return;
    hovering = false;
    window.pet.mouse(false);
    hideBubbleSoon();
  });
}

let drag = null;
sprite.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  sprite.setPointerCapture(e.pointerId);
  drag = { x: e.screenX, y: e.screenY, sx: e.screenX, sy: e.screenY, moved: false, lastDir: null };
});
sprite.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) > 4) {
    drag.moved = true;
    sprite.classList.add('dragging');
  }
  if (drag.moved && (dx || dy)) {
    window.pet.drag(dx, dy);
    drag.x = e.screenX;
    drag.y = e.screenY;
    const dir = dx > 2 ? 'running-right' : dx < -2 ? 'running-left' : drag.lastDir;
    if (dir && dir !== drag.lastDir) {
      drag.lastDir = dir;
      override = { state: dir, loops: 1, sticky: true, speed: 1.2 };
      restart();
    }
  }
});
sprite.addEventListener('pointerup', e => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  sprite.classList.remove('dragging');
  sprite.releasePointerCapture(e.pointerId);
  if (moved) {
    override = null;
    restart();
    window.pet.dragEnd();
  } else {
    window.pet.click();
  }
});
sprite.addEventListener('contextmenu', e => { e.preventDefault(); window.pet.menu(); });
/** A short line at the bottom of the bubble (no native dialogs). */
function note(text, kind) {
  let el = bubble.querySelector('.note');
  if (!el) {
    el = document.createElement('div');
    bubble.appendChild(el);
  }
  el.className = `note ${kind || ''}`;
  el.textContent = text;
  bubbleHtml = ''; // the bubble now differs from the rendered summary: allow the next refresh to redraw it
  positionBubble();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { if (el.isConnected) el.remove(); }, 5000);
}

bubble.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  const row = e.target.closest('[data-thread]');
  if (btn && row) {
    e.stopPropagation();
    btn.disabled = true;
    const r = await window.pet.threadAction(row.dataset.thread, btn.dataset.act);
    btn.disabled = false;
    if (r.ok) {
      row.classList.add('gone');
      const runningRow = /\b(running|stale|waiting)\b/.test(row.className);
      note(btn.dataset.act === 'settle' ? (runningRow ? 'Will settle when this turn ends' : 'Settled') : 'Hidden until it changes', 'ok');
    } else if (r.needsActions) {
      note('Turn on thread actions in the panel’s Settings to settle from here.', 'error');
    } else {
      note(r.error || 'That did not work.', 'error');
    }
    return;
  }
  if (row) window.pet.openThread(row.dataset.thread);
  else window.pet.click();
});
sprite.addEventListener('dblclick', () => react('waving', 1));

// ---------- boot ----------
window.pet.onConfig(applyConfig);
window.pet.onTasks(onTasks);
window.pet.config().then(applyConfig);
window.pet.tasks().then(p => { if (p && p.snapshot) onTasks({ ...p, events: [] }); });
