// Tiny Codex-atlas animator for small previews (panel avatar, pet cards, empty state).
// Usage: const s = new MiniSprite(el, { url, atlas, scale }); s.play('idle'); s.stop();
class MiniSprite {
  constructor(el, { url, atlas, scale = 0.3 }) {
    this.el = el;
    this.atlas = atlas;
    this.scale = scale;
    this.timer = null;
    el.style.width = `${Math.round(atlas.cellWidth * scale)}px`;
    el.style.height = `${Math.round(atlas.cellHeight * scale)}px`;
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = `${atlas.width * scale}px auto`; // auto height: 8x9 and 8x11 (v2) sheets
    el.style.backgroundRepeat = 'no-repeat';
    this.frame(0, 'idle');
  }

  frame(i, state) {
    const st = this.atlas.states[state] || this.atlas.states.idle;
    this.el.style.backgroundPosition = `${-i * this.atlas.cellWidth * this.scale}px ${-st.row * this.atlas.cellHeight * this.scale}px`;
  }

  /** Loop a row; `rest` ms holds the last frame between loops (calm). */
  play(state = 'idle', { speed = 1.4, rest = 2200 } = {}) {
    this.stop();
    const st = this.atlas.states[state] || this.atlas.states.idle;
    let i = 0;
    const step = () => {
      this.frame(i, state);
      const last = i === st.durations.length - 1;
      const wait = st.durations[i] * speed + (last ? rest : 0);
      i = last ? 0 : i + 1;
      this.timer = setTimeout(step, wait);
    };
    step();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
window.MiniSprite = MiniSprite;
