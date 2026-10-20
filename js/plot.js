/* HeroScope — dependency-free time-series chart on canvas.
 * Two layers: a base canvas (grid + series, redrawn on view change) and an
 * overlay (video cursor, hover crosshair, trim shading, markers) redrawn per frame.
 */
'use strict';
class TimeChart {
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = Object.assign({ onSeek: null, onViewChange: null, onHover: null, yMode: 'auto', showPoints: 'auto' }, opts);
    this.series = [];
    this.view = { t0: 0, t1: 1 };
    this.full = { t0: 0, t1: 1 };
    this.cursor = null; this.cursorVisible = true;
    this.trim = null; this.markers = [];
    this.hoverT = null;
    this.margin = { l: 58, r: 12, t: 10, b: 24 };
    this.el.classList.add('tc-root');
    this.base = document.createElement('canvas'); this.base.className = 'tc-base';
    this.over = document.createElement('canvas'); this.over.className = 'tc-over';
    this.tip = document.createElement('div'); this.tip.className = 'tc-tip'; this.tip.hidden = true;
    this.el.append(this.base, this.over, this.tip);
    this._w = 0; this._h = 0; this._dpr = 1;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.el);
    this._bindPointer();
    this.resize();
  }

  destroy() { this._ro.disconnect(); this.el.innerHTML = ''; this.el.classList.remove('tc-root'); }

  colors() {
    const cs = getComputedStyle(this.el);
    const g = n => cs.getPropertyValue(n).trim();
    return { text: g('--text-secondary') || '#999', grid: g('--grid') || 'rgba(128,128,128,.25)', axis: g('--axis') || 'rgba(128,128,128,.5)',
      cursor: g('--cursor') || '#ff3b30', hover: g('--text-secondary') || '#999', trim: g('--trim-dim') || 'rgba(0,0,0,.35)', marker: g('--marker') || '#c98500', surface: g('--surface-1') || '#1a1a19' };
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(10, Math.floor(r.width)), h = Math.max(10, Math.floor(r.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this._w && h === this._h && dpr === this._dpr) return;
    this._w = w; this._h = h; this._dpr = dpr;
    for (const c of [this.base, this.over]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
    this.draw();
  }

  /** series: [{id,label,unit,color,times:Float64Array,values:Float64Array}] */
  setSeries(list) {
    this.series = list.map(s => {
      let min = Infinity, max = -Infinity;
      const v = s.values;
      for (let i = 0; i < v.length; i++) { const x = v[i]; if (x === x) { if (x < min) min = x; if (x > max) max = x; } }
      if (min === Infinity) { min = 0; max = 1; }
      return Object.assign({}, s, { min, max });
    });
    this.draw();
  }
  setFullRange(t0, t1) { this.full = { t0, t1 }; if (this.view.t1 <= this.view.t0) this.view = { t0, t1 }; this.draw(); }
  setView(t0, t1, silent) {
    if (!(t1 > t0)) return;
    this.view = { t0, t1 };
    this.draw();
    if (!silent && this.opts.onViewChange) this.opts.onViewChange(t0, t1);
  }
  resetView() { this.setView(this.full.t0, this.full.t1); }
  setCursor(t) { this.cursor = t; this.drawOverlay(); }
  setCursorVisible(b) { this.cursorVisible = b; this.drawOverlay(); }
  setTrim(tr) { this.trim = tr; this.drawOverlay(); }
  setMarkers(m) { this.markers = m || []; this.drawOverlay(); }
  setYMode(m) { this.opts.yMode = m; this.draw(); }
  setShowPoints(p) { this.opts.showPoints = p; this.draw(); }

  // ---- coordinate helpers
  plotRect() { return { x: this.margin.l, y: this.margin.t, w: Math.max(1, this._w - this.margin.l - this.margin.r), h: Math.max(1, this._h - this.margin.t - this.margin.b) }; }
  tToX(t) { const p = this.plotRect(); return p.x + (t - this.view.t0) / (this.view.t1 - this.view.t0) * p.w; }
  xToT(x) { const p = this.plotRect(); return this.view.t0 + (x - p.x) / p.w * (this.view.t1 - this.view.t0); }

  static lowerBound(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; }
  static nearestIndex(arr, t) {
    if (!arr.length) return -1;
    const i = TimeChart.lowerBound(arr, t);
    if (i <= 0) return 0; if (i >= arr.length) return arr.length - 1;
    return (t - arr[i - 1]) < (arr[i] - t) ? i - 1 : i;
  }
  static niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }
  static timeStep(range, target) {
    const raw = range / Math.max(1, target);
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const s of steps) if (s >= raw) return s;
    return 7200;
  }
  static fmtTime(t, step) {
    const neg = t < 0; t = Math.abs(t);
    const m = Math.floor(t / 60), s = t - m * 60;
    const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    const ss = s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0');
    return (neg ? '-' : '') + m + ':' + ss;
  }
  static fmtVal(v) {
    if (v !== v) return '—';
    const a = Math.abs(v);
    if (a >= 1e6 || (a > 0 && a < 1e-4)) return v.toExponential(3);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    if (a >= 10) return v.toFixed(2);
    return v.toFixed(3);
  }

  /** compute y scale per series for the current view */
  yScales() {
    const p = this.plotRect();
    const mode = this.opts.yMode;
    const out = [];
    const span = (lo, hi) => { if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; } const pad = (hi - lo) * 0.06; return [lo - pad, hi + pad]; };
    if (mode === 'norm') {
      for (const s of this.series) { const [lo, hi] = span(s.min, s.max); out.push({ lo, hi }); }
      return { per: out, shared: null, lo: 0, hi: 1 };
    }
    let lo = Infinity, hi = -Infinity;
    for (const s of this.series) {
      if (mode === 'full') { lo = Math.min(lo, s.min); hi = Math.max(hi, s.max); continue; }
      const a = TimeChart.lowerBound(s.times, this.view.t0), b = TimeChart.lowerBound(s.times, this.view.t1);
      const i0 = Math.max(0, a - 1), i1 = Math.min(s.times.length, b + 1);
      for (let i = i0; i < i1; i++) { const v = s.values[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    [lo, hi] = span(lo, hi);
    for (const s of this.series) out.push({ lo, hi });
    return { per: out, shared: { lo, hi }, lo, hi };
  }

  draw() {
    const ctx = this.base.getContext('2d');
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    const c = this.colors();
    const p = this.plotRect();
    const { t0, t1 } = this.view;
    const ys = this.yScales();
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // y grid
    ctx.lineWidth = 1;
    if (this.series.length) {
      const sh = ys.shared || { lo: 0, hi: 1 };
      const step = TimeChart.niceStep(sh.hi - sh.lo, Math.max(2, p.h / 36));
      const start = Math.ceil(sh.lo / step) * step;
      ctx.strokeStyle = c.grid; ctx.fillStyle = c.text; ctx.textAlign = 'right';
      for (let v = start; v <= sh.hi + 1e-9; v += step) {
        const y = p.y + p.h - (v - sh.lo) / (sh.hi - sh.lo) * p.h;
        ctx.beginPath(); ctx.moveTo(p.x, Math.round(y) + 0.5); ctx.lineTo(p.x + p.w, Math.round(y) + 0.5); ctx.stroke();
        const label = ys.shared ? TimeChart.fmtTick(v, step) : (v * 100).toFixed(0) + '%';
        ctx.fillText(label, p.x - 6, y);
      }
    }
    // x grid
    const ts = TimeChart.timeStep(t1 - t0, p.w / 90);
    ctx.textAlign = 'center';
    for (let t = Math.ceil(t0 / ts) * ts; t <= t1 + 1e-9; t += ts) {
      const x = Math.round(this.tToX(t)) + 0.5;
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
      ctx.fillStyle = c.text; ctx.fillText(TimeChart.fmtTime(t, ts), x, p.y + p.h + 12);
    }
    // axes
    ctx.strokeStyle = c.axis; ctx.beginPath(); ctx.moveTo(p.x + 0.5, p.y); ctx.lineTo(p.x + 0.5, p.y + p.h + 0.5); ctx.lineTo(p.x + p.w, p.y + p.h + 0.5); ctx.stroke();
    // unit label
    const units = [...new Set(this.series.map(s => s.unit).filter(Boolean))];
    if (units.length === 1 && ys.shared) { ctx.save(); ctx.fillStyle = c.text; ctx.textAlign = 'left'; ctx.fillText(units[0], p.x + 4, p.y + 7); ctx.restore(); }
    else if (this.opts.yMode === 'norm') { ctx.save(); ctx.fillStyle = c.text; ctx.textAlign = 'left'; ctx.fillText('normalized', p.x + 4, p.y + 7); ctx.restore(); }
    // series
    ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    this.series.forEach((s, si) => this._drawSeries(ctx, s, ys.per[si], p));
    ctx.restore();
    if (!this.series.length) {
      ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.fillText('No series — use “+ series” below to add data', p.x + p.w / 2, p.y + p.h / 2);
    }
    this.drawOverlay();
  }
  static fmtTick(v, step) {
    const dec = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
    return Math.abs(v) >= 1e5 ? v.toExponential(1) : v.toFixed(dec);
  }

  _drawSeries(ctx, s, sc, p) {
    const { t0, t1 } = this.view;
    const times = s.times, vals = s.values;
    const n = times.length;
    if (!n) return;
    let a = TimeChart.lowerBound(times, t0), b = TimeChart.lowerBound(times, t1);
    a = Math.max(0, a - 1); b = Math.min(n, b + 1);
    const count = b - a;
    const yOf = v => p.y + p.h - (v - sc.lo) / (sc.hi - sc.lo) * p.h;
    const xOf = t => p.x + (t - t0) / (t1 - t0) * p.w;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 1.6;
    const showPts = this.opts.showPoints === 'on' || (this.opts.showPoints === 'auto' && count < p.w / 6);
    if (count <= p.w * 2) {
      ctx.beginPath();
      let pen = false;
      for (let i = a; i < b; i++) {
        const v = vals[i];
        if (v !== v) { pen = false; continue; }
        const x = xOf(times[i]), y = yOf(v);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (showPts) {
        for (let i = a; i < b; i++) { const v = vals[i]; if (v !== v) continue; ctx.beginPath(); ctx.arc(xOf(times[i]), yOf(v), 2.5, 0, Math.PI * 2); ctx.fill(); }
      }
      return;
    }
    // min/max decimation per pixel column
    const w = Math.ceil(p.w);
    const mins = new Float64Array(w).fill(Infinity), maxs = new Float64Array(w).fill(-Infinity);
    const firsts = new Float64Array(w), lasts = new Float64Array(w);
    const has = new Uint8Array(w);
    const k = p.w / (t1 - t0);
    for (let i = a; i < b; i++) {
      const v = vals[i]; if (v !== v) continue;
      let col = Math.floor((times[i] - t0) * k);
      if (col < 0) col = 0; else if (col >= w) col = w - 1;
      if (!has[col]) { has[col] = 1; firsts[col] = v; }
      lasts[col] = v;
      if (v < mins[col]) mins[col] = v; if (v > maxs[col]) maxs[col] = v;
    }
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let col = 0; col < w; col++) {
      if (!has[col]) continue;
      const x = p.x + col + 0.5;
      if (!pen) { ctx.moveTo(x, yOf(firsts[col])); pen = true; } else ctx.lineTo(x, yOf(firsts[col]));
      if (mins[col] !== maxs[col]) { ctx.lineTo(x, yOf(mins[col])); ctx.lineTo(x, yOf(maxs[col])); }
      ctx.lineTo(x, yOf(lasts[col]));
    }
    ctx.stroke();
  }

  drawOverlay() {
    const ctx = this.over.getContext('2d');
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    const c = this.colors();
    const p = this.plotRect();
    ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    // trim shading
    if (this.trim) {
      ctx.fillStyle = c.trim;
      const xi = this.tToX(this.trim.in), xo = this.tToX(this.trim.out);
      if (xi > p.x) ctx.fillRect(p.x, p.y, Math.min(p.w, xi - p.x), p.h);
      if (xo < p.x + p.w) ctx.fillRect(Math.max(p.x, xo), p.y, p.x + p.w - Math.max(p.x, xo), p.h);
      ctx.strokeStyle = c.marker; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      for (const x of [xi, xo]) { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, p.y); ctx.lineTo(Math.round(x) + 0.5, p.y + p.h); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    // markers
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    for (const m of this.markers) {
      const x = Math.round(this.tToX(m.t)) + 0.5;
      if (x < p.x || x > p.x + p.w) continue;
      ctx.strokeStyle = c.marker; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
      ctx.fillStyle = c.marker; ctx.fillText(m.label || '', x + 3, p.y + 2);
    }
    // hover crosshair + dots
    if (this.hoverT !== null) {
      const x = Math.round(this.tToX(this.hoverT)) + 0.5;
      ctx.strokeStyle = c.hover; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); ctx.setLineDash([]);
      const ys = this.yScales();
      this.series.forEach((s, si) => {
        const i = TimeChart.nearestIndex(s.times, this.hoverT);
        if (i < 0) return; const v = s.values[i]; if (v !== v) return;
        const sc = ys.per[si];
        const y = p.y + p.h - (v - sc.lo) / (sc.hi - sc.lo) * p.h;
        ctx.fillStyle = s.color; ctx.strokeStyle = c.surface; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(this.tToX(s.times[i]), y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
    }
    // video cursor
    if (this.cursorVisible && this.cursor !== null) {
      const x = Math.round(this.tToX(this.cursor)) + 0.5;
      if (x >= p.x - 1 && x <= p.x + p.w + 1) {
        ctx.strokeStyle = c.cursor; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
        ctx.fillStyle = c.cursor; ctx.beginPath(); ctx.moveTo(x - 5, p.y); ctx.lineTo(x + 5, p.y); ctx.lineTo(x, p.y + 6); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }

  valuesAt(t) {
    return this.series.map(s => { const i = TimeChart.nearestIndex(s.times, t); return { series: s, index: i, value: i >= 0 ? s.values[i] : NaN, time: i >= 0 ? s.times[i] : NaN }; });
  }

  _showTip(clientX, clientY, t) {
    const rows = this.valuesAt(t);
    const tip = this.tip;
    tip.innerHTML = '';
    const h = document.createElement('div'); h.className = 'tc-tip-time'; h.textContent = 't = ' + TimeChart.fmtTime(t, 0.001) + '  (' + t.toFixed(3) + ' s)';
    tip.appendChild(h);
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'tc-tip-row';
      const sw = document.createElement('span'); sw.className = 'tc-tip-key'; sw.style.background = r.series.color;
      const val = document.createElement('strong'); val.textContent = TimeChart.fmtVal(r.value) + (r.series.unit ? ' ' + r.series.unit : '');
      const lab = document.createElement('span'); lab.className = 'tc-tip-label'; lab.textContent = r.series.label;
      row.append(sw, val, lab); tip.appendChild(row);
    }
    tip.hidden = false;
    const er = this.el.getBoundingClientRect();
    let x = clientX - er.left + 14, y = clientY - er.top + 10;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > er.width - 4) x = clientX - er.left - tw - 14;
    if (y + th > er.height - 4) y = Math.max(0, er.height - th - 4);
    tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  _bindPointer() {
    const el = this.over;
    let drag = null;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      drag = { x0: e.clientX, t0: this.view.t0, t1: this.view.t1, moved: false };
    });
    el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (drag) {
        const dx = e.clientX - drag.x0;
        if (Math.abs(dx) > 3) drag.moved = true;
        if (drag.moved) {
          const p = this.plotRect();
          const dt = -dx / p.w * (drag.t1 - drag.t0);
          this.setView(drag.t0 + dt, drag.t1 + dt);
          this.tip.hidden = true; this.hoverT = null;
          return;
        }
      }
      const p = this.plotRect();
      if (x < p.x || x > p.x + p.w) { this.hoverT = null; this.tip.hidden = true; this.drawOverlay(); return; }
      this.hoverT = this.xToT(x);
      this._showTip(e.clientX, e.clientY, this.hoverT);
      this.drawOverlay();
      if (this.opts.onHover) this.opts.onHover(this.hoverT);
    });
    const end = e => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved && this.opts.onSeek) {
        const r = el.getBoundingClientRect();
        const p = this.plotRect();
        const x = e.clientX - r.left;
        if (x >= p.x && x <= p.x + p.w) this.opts.onSeek(this.xToT(x));
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { drag = null; });
    el.addEventListener('pointerleave', () => { if (!drag) { this.hoverT = null; this.tip.hidden = true; this.drawOverlay(); if (this.opts.onHover) this.opts.onHover(null); } });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const p = this.plotRect();
      const x = Math.min(p.x + p.w, Math.max(p.x, e.clientX - r.left));
      const tAt = this.xToT(x);
      const f = Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 20 : 1));
      let t0 = tAt - (tAt - this.view.t0) * f, t1 = tAt + (this.view.t1 - tAt) * f;
      const minSpan = 0.002, maxSpan = (this.full.t1 - this.full.t0) * 4 || 1;
      if (t1 - t0 < minSpan || t1 - t0 > maxSpan) return;
      this.setView(t0, t1);
      this.hoverT = this.xToT(x); this.drawOverlay();
    }, { passive: false });
    el.addEventListener('dblclick', () => this.resetView());
  }
}
if (typeof module !== 'undefined') module.exports = TimeChart;
