/* HeroScope — application: file loading, frame-accurate transport, timeline,
 * configurable dashboard, trim, markers, screenshots and exports. */
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const PALETTE = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
  const LS_LAYOUT = 'heroscope.layout.v1', LS_PREFS = 'heroscope.prefs.v1';

  // ---------------- state
  const S = {
    file: null, info: null, streams: {}, devices: {}, duration: 0, fps: 30, frames: 0,
    trim: { in: 0, out: 0 }, markers: [], cursorOn: true, follow: true, link: true,
    view: { t0: 0, t1: 1 }, speed: 1, loop: true, rev: false, hud: true,
    layout: { cols: 2, panels: [] }, charts: new Map(), panelEls: new Map(),
    zoom: 1, pan: { x: 0, y: 0 }, burnTc: false, lastTick: 0, ready: false, rafId: 0,
  };
  const video = $('video');

  // ---------------- small utils
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }
  function status(msg) { $('status').textContent = msg; }
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
  function baseName() { return (S.file ? S.file.name : 'clip').replace(/\.[^.]+$/, ''); }
  function frameOf(t) { return Math.max(0, Math.floor(t * S.fps + 1e-4)); }
  function timeOfFrame(f) { return (f + 0.5) / S.fps; }
  function timecode(t) {
    const f = frameOf(t);
    const fi = f % Math.round(S.fps), s = Math.floor(f / S.fps);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}:${pad(fi, S.fps >= 100 ? 3 : 2)}`;
  }
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  function isTyping() { const a = document.activeElement; return a && (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); }
  function hasTrim() { return S.duration > 0 && (S.trim.in > 0.0001 || S.trim.out < S.duration - 0.0001); }

  // ---------------- dialog
  function dialog({ title, body, buttons }) {
    const d = $('dlg');
    $('dlgTitle').textContent = title;
    const b = $('dlgBody'); b.innerHTML = ''; b.append(body);
    const m = $('dlgButtons'); m.innerHTML = '';
    for (const bt of buttons || [{ label: 'Close' }]) {
      const btn = el('button', { type: 'button', class: bt.primary ? 'primary' : '', text: bt.label });
      btn.addEventListener('click', () => { if (!bt.onClick || bt.onClick() !== false) d.close(); });
      m.append(btn);
    }
    d.showModal();
  }

  // ---------------- file loading
  async function openFile(file) {
    if (!file) return;
    S.file = file; S.ready = false; S.rev = false;
    $('fileName').textContent = file.name + ' · ' + (file.size / 1e6).toFixed(1) + ' MB';
    $('dropHint').classList.add('hidden');
    $('videoMsg').hidden = true;
    status('Opening ' + file.name + '…');
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    video.load();
    S.markers = []; S.zoom = 1; S.pan = { x: 0, y: 0 }; applyZoom();
    let info = null, streams = {}, devices = {};
    try {
      const r = await MP4.open(file, status);
      info = r.info;
      if (r.payloads.length) {
        const ex = GPMF.extract(r.payloads, status);
        streams = ex.streams; devices = ex.devices;
      }
    } catch (e) {
      console.error(e);
      toast('Could not parse container: ' + e.message, 5000);
    }
    S.info = info; S.streams = streams; S.devices = devices;
    const keys = Object.keys(streams);
    if (info && info.video && info.video.fps) S.fps = info.video.fps;
    S.duration = (info && info.duration) || 0;
    if (video.duration && isFinite(video.duration)) S.duration = Math.max(S.duration, video.duration);
    S.frames = Math.round(S.duration * S.fps);
    S.trim = { in: 0, out: S.duration };
    const t1 = Math.max(S.duration, ...keys.map(k => streams[k].t1), 1);
    S.view = { t0: 0, t1 };
    if (!keys.length) toast('No GPMF telemetry track found in this file. Video controls still work.', 5000);
    status(`${file.name} — ${keys.length} telemetry stream${keys.length === 1 ? '' : 's'}: ${keys.join(', ') || 'none'} · ${S.fps.toFixed(3)} fps`);
    S.ready = true;
    if (!S.layout.panels.length) S.layout = makePreset('default');
    renderDashboard();
    updateTrimInfo(); updateMarkInfo();
    syncUI(0, true);
    drawTimeline();
  }
  video.addEventListener('loadedmetadata', () => {
    if (isFinite(video.duration)) { S.duration = Math.max(S.duration, video.duration); S.frames = Math.round(S.duration * S.fps); if (S.trim.out === 0 || S.trim.out > S.duration) S.trim.out = S.duration; }
    syncUI(0, true); drawTimeline(); updateTrimInfo();
  });
  video.addEventListener('error', () => {
    const err = video.error;
    const codec = S.info && S.info.video ? S.info.video.codec : '?';
    const m = $('videoMsg');
    m.hidden = false;
    m.textContent = `This browser cannot decode the video track (codec "${codec}", error ${err ? err.code : '?'}). ` +
      (/hvc1|hev1/i.test(codec) ? 'HEVC (H.265) needs hardware support — try Safari, Edge, or Chrome on a machine with HEVC decoding, or transcode: ffmpeg -i in.MP4 -map 0 -c copy -c:v libx264 out.mp4 (GPMF is kept with -map 0 -c copy).' : '') +
      ' Telemetry graphs still work.';
  });
  $('fileInput').addEventListener('change', e => openFile(e.target.files[0]));
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('btnDemo').addEventListener('click', async () => {
    status('Loading demo clip…');
    try {
      const r = await fetch('fixtures/demo.mp4');
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      const b = await r.blob();
      openFile(new File([b], 'demo.mp4', { type: 'video/mp4' }));
    } catch (e) { toast('Demo needs the page to be served over http(s) (fixtures/demo.mp4): ' + e.message, 6000); status('Ready.'); }
  });
  const wrap = $('videoWrap');
  for (const evn of ['dragenter', 'dragover']) document.addEventListener(evn, e => { e.preventDefault(); wrap.classList.add('dragover'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) wrap.classList.remove('dragover'); });
  document.addEventListener('drop', e => { e.preventDefault(); wrap.classList.remove('dragover'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });

  // ---------------- transport / playback engine
  function currentTime() { return video.currentTime || 0; }
  function seek(t, exactFrame) {
    t = clamp(t, 0, Math.max(0, S.duration - 0.0005));
    if (exactFrame) t = clamp(timeOfFrame(frameOf(t)), 0, Math.max(0, S.duration - 0.0005));
    video.currentTime = t;
    syncUI(t, 'seek');
  }
  function seekFrame(f) { seek(timeOfFrame(clamp(f, 0, Math.max(0, S.frames - 1)))); }
  function step(df) { S.rev = false; video.pause(); seekFrame(frameOf(currentTime()) + df); }
  function play() {
    S.rev = false; $('tRev').classList.remove('on');
    if (hasTrim() && (currentTime() >= S.trim.out - 0.001 || currentTime() < S.trim.in - 0.001)) video.currentTime = S.trim.in;
    else if (!hasTrim() && currentTime() >= S.duration - 0.001) video.currentTime = 0;
    video.playbackRate = S.speed;
    video.play().catch(e => toast('Playback failed: ' + e.message));
  }
  function pause() { video.pause(); S.rev = false; $('tRev').classList.remove('on'); }
  function togglePlay() { if (S.rev || !video.paused) pause(); else play(); }
  function playReverse() {
    video.pause(); S.rev = true; $('tRev').classList.add('on'); S.lastTick = performance.now();
    $('tPlay').textContent = '❚❚';
  }
  function setSpeed(v) {
    S.speed = clamp(v, 0.05, 16);
    $('speed').value = Math.log10(S.speed);
    $('speedVal').textContent = S.speed.toFixed(2) + '×';
    video.playbackRate = S.speed;
  }
  const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];
  function speedStep(dir) {
    const i = SPEEDS.findIndex(s => s >= S.speed - 1e-9);
    let n = dir > 0 ? (i < 0 ? SPEEDS.length - 1 : Math.min(SPEEDS.length - 1, (Math.abs(SPEEDS[i] - S.speed) < 1e-9 ? i + 1 : i))) : (i < 0 ? SPEEDS.length - 1 : Math.max(0, i - 1));
    setSpeed(SPEEDS[n]);
  }
  $('speed').addEventListener('input', e => setSpeed(Math.pow(10, parseFloat(e.target.value))));
  $('tPlay').addEventListener('click', togglePlay);
  $('tBack1').addEventListener('click', () => step(-1));
  $('tFwd1').addEventListener('click', () => step(1));
  $('tBack10').addEventListener('click', () => step(-10));
  $('tFwd10').addEventListener('click', () => step(10));
  $('tStart').addEventListener('click', () => { pause(); seek(hasTrim() ? S.trim.in : 0); });
  $('tEnd').addEventListener('click', () => { pause(); seekFrame((hasTrim() ? frameOf(S.trim.out) : S.frames) - 1); });
  $('tRev').addEventListener('click', () => S.rev ? pause() : playReverse());
  $('tLoop').addEventListener('click', e => { S.loop = !S.loop; e.target.classList.toggle('on', S.loop); });
  $('tMute').addEventListener('click', e => { video.muted = !video.muted; e.target.classList.toggle('on', video.muted); });
  $('tHud').addEventListener('click', e => { S.hud = !S.hud; e.target.classList.toggle('on', S.hud); syncUI(currentTime(), true); savePrefs(); });
  $('burnTc').addEventListener('change', e => { S.burnTc = e.target.checked; savePrefs(); });
  video.addEventListener('play', () => { $('tPlay').textContent = '❚❚'; });
  video.addEventListener('pause', () => { if (!S.rev) $('tPlay').textContent = '▶'; });
  video.addEventListener('seeked', () => syncUI(currentTime(), true));
  video.addEventListener('timeupdate', () => { if (!('requestVideoFrameCallback' in video)) syncUI(currentTime()); });

  // frame-accurate presentation callback
  if ('requestVideoFrameCallback' in video) {
    const onFrame = (now, meta) => { syncUI(meta.mediaTime); video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }
  // rAF loop: reverse playback + trim loop enforcement
  function raf(now) {
    S.rafId = requestAnimationFrame(raf);
    if (!S.ready) return;
    const t = currentTime();
    if (S.rev) {
      const dt = (now - S.lastTick) / 1000; S.lastTick = now;
      if (!video.seeking) {
        const lo = hasTrim() ? S.trim.in : 0;
        let nt = t - dt * S.speed;
        if (nt <= lo) { if (S.loop) nt = (hasTrim() ? S.trim.out : S.duration) - 0.001; else { nt = lo; pause(); } }
        video.currentTime = nt;
      }
      return;
    }
    if (!video.paused) {
      const hi = hasTrim() ? S.trim.out : S.duration;
      if (t >= hi - 0.0005 && hi > 0) {
        if (S.loop) video.currentTime = hasTrim() ? S.trim.in : 0;
        else if (hasTrim()) { video.pause(); video.currentTime = hi - 0.0005; }
      } else if (hasTrim() && t < S.trim.in - 0.5) {
        // user scrubbed before the in point while playing: allow it, no clamp
      }
    }
  }
  S.rafId = requestAnimationFrame(raf);

  /** Update all time-dependent UI for media time t. */
  let lastSync = { t: -1 };
  function syncUI(t, force) {
    if (t == null) t = currentTime();
    if (!force && Math.abs(t - lastSync.t) < 1e-6) return;
    lastSync.t = t;
    const f = frameOf(t);
    $('tcMain').textContent = timecode(t);
    $('tcFrame').textContent = 'F ' + f + ' / ' + S.frames;
    $('tcSec').textContent = t.toFixed(3) + ' s';
    $('videoHud').textContent = S.hud && S.file ? `${timecode(t)}  F${f}  ${t.toFixed(3)}s  ${S.rev ? '◀' : ''}${S.speed !== 1 || S.rev ? S.speed.toFixed(2) + '×' : ''}`.trim() : '';
    // follow
    if (S.cursorOn && S.follow && S.ready && (!video.paused || S.rev || force === 'seek')) {
      const span = S.view.t1 - S.view.t0;
      if (t > S.view.t1 - span * 0.05 || t < S.view.t0) {
        if (span < Math.max(S.duration, 1) - 1e-6) {
          const t0 = clamp(t - span * 0.1, 0, Math.max(0, Math.max(S.duration, S.view.t1) - span));
          setView(t0, t0 + span, null);
        }
      }
    }
    for (const ch of S.charts.values()) ch.setCursor(t);
    updateValuePanels(t);
    updateTrackPanels(t);
    drawTimelineOverlay();
  }

  // ---------------- video zoom / pan
  function applyZoom() {
    video.style.transform = S.zoom === 1 ? '' : `translate(${S.pan.x}px, ${S.pan.y}px) scale(${S.zoom})`;
    $('zoomSelect').value = [1, 2, 4, 8].includes(S.zoom) ? String(S.zoom) : $('zoomSelect').value;
  }
  function setZoom(z, cx, cy) {
    const r = wrap.getBoundingClientRect();
    cx = cx == null ? r.width / 2 : cx; cy = cy == null ? r.height / 2 : cy;
    const nz = clamp(z, 1, 8);
    // keep the point under (cx,cy) fixed
    S.pan.x = cx - (cx - S.pan.x) * (nz / S.zoom);
    S.pan.y = cy - (cy - S.pan.y) * (nz / S.zoom);
    S.zoom = nz;
    if (nz === 1) S.pan = { x: 0, y: 0 };
    clampPan(); applyZoom();
  }
  function clampPan() {
    const r = wrap.getBoundingClientRect();
    S.pan.x = clamp(S.pan.x, r.width * (1 - S.zoom), 0);
    S.pan.y = clamp(S.pan.y, r.height * (1 - S.zoom), 0);
  }
  $('zoomSelect').addEventListener('change', e => setZoom(parseFloat(e.target.value)));
  wrap.addEventListener('wheel', e => { if (!S.file) return; e.preventDefault(); const r = wrap.getBoundingClientRect(); setZoom(S.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  (function () {
    let d = null;
    wrap.addEventListener('pointerdown', e => { if (e.button !== 0 || S.zoom === 1) return; d = { x: e.clientX, y: e.clientY, px: S.pan.x, py: S.pan.y }; wrap.setPointerCapture(e.pointerId); });
    wrap.addEventListener('pointermove', e => { if (!d) return; S.pan.x = d.px + e.clientX - d.x; S.pan.y = d.py + e.clientY - d.y; clampPan(); applyZoom(); });
    wrap.addEventListener('pointerup', () => { d = null; });
    wrap.addEventListener('dblclick', () => setZoom(1));
    wrap.addEventListener('click', e => { if (e.detail === 1 && S.zoom === 1 && S.file && e.target === video) togglePlay(); });
  })();

  // ---------------- trim & markers
  function setIn() { const t = timeOfFrame(frameOf(currentTime())) - 0.5 / S.fps; S.trim.in = clamp(t, 0, S.duration); if (S.trim.out <= S.trim.in) S.trim.out = S.duration; afterTrimChange(); }
  function setOut() { const t = timeOfFrame(frameOf(currentTime())) + 0.5 / S.fps; S.trim.out = clamp(t, 0, S.duration); if (S.trim.in >= S.trim.out) S.trim.in = 0; afterTrimChange(); }
  function clearTrim() { S.trim = { in: 0, out: S.duration }; afterTrimChange(); }
  function afterTrimChange() { updateTrimInfo(); for (const ch of S.charts.values()) ch.setTrim(hasTrim() ? S.trim : null); drawTimeline(); updateTrackPanels(currentTime()); }
  function updateTrimInfo() {
    const e = $('trimInfo');
    if (!S.duration) { e.textContent = ''; return; }
    const fi = frameOf(S.trim.in), fo = Math.max(fi, Math.round(S.trim.out * S.fps));
    e.textContent = hasTrim() ? `${timecode(S.trim.in)} → ${timecode(S.trim.out - 0.5 / S.fps)}  (${fo - fi} f, ${(S.trim.out - S.trim.in).toFixed(3)} s)` : 'full clip';
  }
  $('tIn').addEventListener('click', setIn); $('tOut').addEventListener('click', setOut); $('tClearTrim').addEventListener('click', clearTrim);
  $('tGoIn').addEventListener('click', () => seek(S.trim.in + 0.5 / S.fps));
  $('tGoOut').addEventListener('click', () => seek(S.trim.out - 0.5 / S.fps));
  function addMarker() {
    const t = timeOfFrame(frameOf(currentTime()));
    if (S.markers.some(m => Math.abs(m.t - t) < 0.5 / S.fps)) return;
    S.markers.push({ t, label: 'M' + (S.markers.length + 1) });
    S.markers.sort((a, b) => a.t - b.t);
    S.markers.forEach((m, i) => { m.label = 'M' + (i + 1); });
    afterMarkerChange();
  }
  function afterMarkerChange() { updateMarkInfo(); for (const ch of S.charts.values()) ch.setMarkers(S.markers); drawTimeline(); }
  function updateMarkInfo() { $('markInfo').textContent = S.markers.length ? S.markers.map(m => m.label + '@' + timecode(m.t)).join('  ') : ''; }
  function gotoMarker(dir) {
    const t = currentTime();
    const list = dir > 0 ? S.markers.filter(m => m.t > t + 0.6 / S.fps) : S.markers.filter(m => m.t < t - 0.6 / S.fps).reverse();
    if (list.length) seek(list[0].t);
  }
  $('tMark').addEventListener('click', addMarker);
  $('tPrevMark').addEventListener('click', () => gotoMarker(-1));
  $('tNextMark').addEventListener('click', () => gotoMarker(1));
  $('tClearMarks').addEventListener('click', () => { S.markers = []; afterMarkerChange(); });

  // ---------------- timeline
  const tl = $('timeline');
  function tlLayout() { const r = tl.getBoundingClientRect(); return { w: r.width, h: r.height, x0: 8, x1: r.width - 8 }; }
  function tlX(t) { const L = tlLayout(); return L.x0 + (t / Math.max(S.duration, 1e-6)) * (L.x1 - L.x0); }
  function tlT(x) { const L = tlLayout(); return clamp((x - L.x0) / (L.x1 - L.x0), 0, 1) * S.duration; }
  let tlBase = null;
  function drawTimeline() {
    const r = tl.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    tl.width = Math.round(r.width * dpr); tl.height = Math.round(r.height * dpr);
    const L = tlLayout();
    const c = document.createElement('canvas'); c.width = tl.width; c.height = tl.height;
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = cssVar('--surface-2'); ctx.fillRect(0, 0, L.w, L.h);
    if (!S.duration) { tlBase = c; drawTimelineOverlay(); return; }
    // mini plot of accelerometer magnitude (or first stream)
    const s = S.streams.ACCL || S.streams.GYRO || Object.values(S.streams)[0];
    if (s) {
      const col = s.cols[s.comps - 1]; const w = Math.max(1, Math.floor(L.x1 - L.x0));
      const mins = new Float64Array(w).fill(Infinity), maxs = new Float64Array(w).fill(-Infinity);
      let gmin = Infinity, gmax = -Infinity;
      for (let i = 0; i < s.count; i++) { const v = col[i]; if (v !== v) continue; const k = clamp(Math.floor(s.times[i] / S.duration * w), 0, w - 1); if (v < mins[k]) mins[k] = v; if (v > maxs[k]) maxs[k] = v; if (v < gmin) gmin = v; if (v > gmax) gmax = v; }
      if (gmax > gmin) {
        ctx.fillStyle = cssVar('--s1'); ctx.globalAlpha = 0.55;
        const top = 14, bottom = L.h - 14;
        for (let k = 0; k < w; k++) { if (mins[k] === Infinity) continue; const y1 = bottom - (maxs[k] - gmin) / (gmax - gmin) * (bottom - top), y2 = bottom - (mins[k] - gmin) / (gmax - gmin) * (bottom - top); ctx.fillRect(L.x0 + k, y1, 1, Math.max(1, y2 - y1)); }
        ctx.globalAlpha = 1;
      }
    }
    // trim shading
    if (hasTrim()) { ctx.fillStyle = cssVar('--trim-dim'); ctx.fillRect(L.x0, 0, tlX(S.trim.in) - L.x0, L.h); ctx.fillRect(tlX(S.trim.out), 0, L.x1 - tlX(S.trim.out), L.h); }
    // ticks
    ctx.fillStyle = cssVar('--text-muted'); ctx.font = '10px ' + cssVar('--font'); ctx.textBaseline = 'bottom';
    const step = TimeChart.timeStep(S.duration, L.w / 80);
    for (let t = 0; t <= S.duration + 1e-9; t += step) { const x = tlX(t); ctx.fillRect(x, L.h - 6, 1, 6); ctx.textAlign = t === 0 ? 'left' : (t + step > S.duration ? 'right' : 'center'); ctx.fillText(TimeChart.fmtTime(t, step), x, L.h - 7); }
    // markers
    ctx.fillStyle = cssVar('--marker');
    for (const m of S.markers) { const x = Math.round(tlX(m.t)); ctx.fillRect(x, 0, 1, L.h - 12); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(m.label, x + 2, 1); }
    // in/out handles
    if (hasTrim()) {
      ctx.fillStyle = cssVar('--marker');
      for (const [t, dir] of [[S.trim.in, 1], [S.trim.out, -1]]) { const x = tlX(t); ctx.fillRect(x - (dir < 0 ? 2 : 0), 0, 2, L.h); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + dir * 8, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill(); }
    }
    tlBase = c;
    drawTimelineOverlay();
  }
  function drawTimelineOverlay() {
    if (!tlBase) return;
    const ctx = tl.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(tlBase, 0, 0); ctx.scale(dpr, dpr);
    if (!S.duration) return;
    const L = tlLayout(); const x = tlX(currentTime());
    ctx.fillStyle = cssVar('--cursor'); ctx.fillRect(x - 0.75, 0, 1.5, L.h);
    ctx.beginPath(); ctx.moveTo(x - 5, L.h); ctx.lineTo(x + 5, L.h); ctx.lineTo(x, L.h - 6); ctx.closePath(); ctx.fill();
  }
  (function () {
    let mode = null;
    tl.addEventListener('pointerdown', e => {
      if (!S.duration) return;
      tl.setPointerCapture(e.pointerId);
      const x = e.clientX - tl.getBoundingClientRect().left;
      mode = 'scrub';
      if (hasTrim()) { if (Math.abs(x - tlX(S.trim.in)) < 7) mode = 'in'; else if (Math.abs(x - tlX(S.trim.out)) < 7) mode = 'out'; }
      if (mode === 'scrub') { S.rev = false; seek(tlT(x)); }
    });
    tl.addEventListener('pointermove', e => {
      const x = e.clientX - tl.getBoundingClientRect().left;
      if (!mode) { tl.style.cursor = hasTrim() && (Math.abs(x - tlX(S.trim.in)) < 7 || Math.abs(x - tlX(S.trim.out)) < 7) ? 'ew-resize' : 'crosshair'; return; }
      const t = tlT(x);
      if (mode === 'scrub') seek(t);
      else if (mode === 'in') { S.trim.in = clamp(Math.floor(t * S.fps) / S.fps, 0, S.trim.out - 1 / S.fps); afterTrimChange(); }
      else if (mode === 'out') { S.trim.out = clamp(Math.ceil(t * S.fps) / S.fps, S.trim.in + 1 / S.fps, S.duration); afterTrimChange(); }
    });
    const up = () => { mode = null; };
    tl.addEventListener('pointerup', up); tl.addEventListener('pointercancel', up);
    new ResizeObserver(() => drawTimeline()).observe(tl);
  })();

  // ---------------- dashboard
  let panelSeq = 1;
  const newId = () => 'p' + Date.now().toString(36) + (panelSeq++);
  function seriesLabel(ref) { const s = S.streams[ref.stream]; if (!s) return ref.stream + '[' + ref.comp + ']'; const l = s.labels[ref.comp]; return s.key + (l ? ' ' + l : ''); }
  function resolveSeries(ref, i) {
    const s = S.streams[ref.stream];
    if (!s || ref.comp >= s.comps) return null;
    return { id: ref.stream + ':' + ref.comp, label: seriesLabel(ref), unit: s.units[ref.comp] || '', color: ref.color || cssVar(PALETTE[i % PALETTE.length]), times: s.times, values: s.cols[ref.comp] };
  }
  function streamsSorted() { return Object.values(S.streams).sort((a, b) => a.key.localeCompare(b.key)); }
  function numericStreams() { return streamsSorted().filter(s => s.cols.length && s.times.length > 1); }

  function makePreset(name) {
    const have = k => !!S.streams[k];
    const chart = (title, refs, extra) => Object.assign({ id: newId(), type: 'chart', title, series: refs, ymode: 'auto', points: 'auto', span: 1, h: 'm' }, extra || {});
    const allComps = (k, excludeMag) => { const s = S.streams[k]; if (!s) return []; return s.labels.map((_, c) => ({ stream: k, comp: c })).filter(r => !excludeMag || s.labels[r.comp] !== '|magnitude|'); };
    const panels = [];
    const gpsKey = have('GPS9') ? 'GPS9' : have('GPS5') ? 'GPS5' : null;
    if (name === 'blank') return { cols: S.layout.cols, panels: [] };
    if (name === 'motion' || name === 'default') {
      if (have('ACCL')) panels.push(chart('Accelerometer', allComps('ACCL', true)));
      if (have('GYRO')) panels.push(chart('Gyroscope', allComps('GYRO', true)));
      if (name === 'motion') {
        if (have('GRAV')) panels.push(chart('Gravity vector', allComps('GRAV', true)));
        if (have('CORI')) panels.push(chart('Camera orientation (quaternion)', allComps('CORI')));
        panels.push({ id: newId(), type: 'values', title: 'Live values', series: [have('ACCL') && { stream: 'ACCL', comp: 3 }, have('GYRO') && { stream: 'GYRO', comp: 3 }].filter(Boolean), span: 1, h: 's' });
      }
    }
    if (name === 'gps' || name === 'default') {
      if (gpsKey) {
        panels.push(chart('GPS speed', [{ stream: gpsKey, comp: 3 }, { stream: gpsKey, comp: 4 }]));
        if (name === 'gps') panels.push(chart('Altitude', [{ stream: gpsKey, comp: 2 }]));
        panels.push({ id: newId(), type: 'track', title: 'GPS track', stream: gpsKey, span: 1, h: 'm' });
        if (name === 'gps') panels.push({ id: newId(), type: 'values', title: 'GPS values', series: [0, 1, 2, 3].map(c => ({ stream: gpsKey, comp: c })), span: 1, h: 's' });
      }
    }
    if (name === 'camera') {
      if (have('SHUT')) panels.push(chart('Shutter speed', allComps('SHUT')));
      if (have('ISOE')) panels.push(chart('ISO', allComps('ISOE')));
      if (have('WBAL')) panels.push(chart('White balance', allComps('WBAL')));
      if (have('WRGB')) panels.push(chart('White balance RGB gains', allComps('WRGB')));
      if (have('UNIF')) panels.push(chart('Image uniformity', allComps('UNIF')));
      if (have('YAVG')) panels.push(chart('Luma average', allComps('YAVG')));
    }
    if (name === 'all') for (const s of numericStreams()) panels.push(chart(s.key + ' — ' + s.name, allComps(s.key)));
    if (name === 'default') panels.push({ id: newId(), type: 'values', title: 'Live values', series: [have('ACCL') && { stream: 'ACCL', comp: 3 }, have('GYRO') && { stream: 'GYRO', comp: 3 }, gpsKey && { stream: gpsKey, comp: 3 }].filter(Boolean), span: 1, h: 's' });
    if (name === 'default' || name === 'camera' || name === 'gps' || name === 'motion') if (!panels.length) panels.push(chart('Chart', []));
    if (name === 'default') panels.push({ id: newId(), type: 'info', title: 'File info', span: 1, h: 'm' });
    return { cols: S.layout.cols, panels };
  }

  function renderDashboard() {
    for (const ch of S.charts.values()) ch.destroy();
    S.charts.clear(); S.panelEls.clear();
    const dash = $('dash');
    dash.innerHTML = '';
    dash.className = 'dash cols-' + S.layout.cols;
    $('colsSelect').value = String(S.layout.cols);
    for (const p of S.layout.panels) dash.append(buildPanel(p));
    saveLayout();
    syncUI(currentTime(), true);
  }
  function rerenderPanel(p) {
    const old = S.panelEls.get(p.id);
    const ch = S.charts.get(p.id); if (ch) { ch.destroy(); S.charts.delete(p.id); }
    const n = buildPanel(p);
    if (old) old.replaceWith(n); else $('dash').append(n);
    saveLayout(); syncUI(currentTime(), true);
  }
  function removePanel(p) { S.layout.panels = S.layout.panels.filter(x => x !== p); renderDashboard(); }
  function movePanel(p, dir) { const i = S.layout.panels.indexOf(p), j = i + dir; if (j < 0 || j >= S.layout.panels.length) return; S.layout.panels.splice(i, 1); S.layout.panels.splice(j, 0, p); renderDashboard(); }

  function buildPanel(p) {
    const root = el('div', { class: 'panel span-' + (p.span || 1) + ' h-' + (p.h || 'm'), 'data-id': p.id, 'data-type': p.type });
    const title = el('input', { class: 'title', value: p.title || '', placeholder: 'Panel title', title: 'Panel title (click to edit)' });
    title.addEventListener('change', () => { p.title = title.value; saveLayout(); });
    const head = el('div', { class: 'panel-head' }, title);
    if (p.type === 'track') {
      const sel = el('select', { title: 'GPS stream' });
      for (const s of streamsSorted().filter(s => /^GPS[59]$/.test(s.key))) sel.append(el('option', { value: s.id, text: s.id }));
      sel.value = p.stream || sel.value; p.stream = sel.value;
      sel.addEventListener('change', () => { p.stream = sel.value; rerenderPanel(p); });
      head.append(sel);
    }
    const hsel = el('select', { title: 'Panel height' });
    for (const [v, l] of [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]) hsel.append(el('option', { value: v, text: l }));
    hsel.value = p.h || 'm';
    hsel.addEventListener('change', () => { p.h = hsel.value; root.className = root.className.replace(/h-\w+/, 'h-' + p.h); saveLayout(); const ch = S.charts.get(p.id); if (ch) ch.resize(); });
    const spanBtn = el('button', { text: p.span > 1 ? '⊟' : '⊞', title: 'Toggle full-width panel', onclick: () => { p.span = p.span > 1 ? 1 : 99; rerenderPanel(p); } });
    head.append(hsel, spanBtn,
      el('button', { text: '↑', title: 'Move up', onclick: () => movePanel(p, -1) }),
      el('button', { text: '↓', title: 'Move down', onclick: () => movePanel(p, 1) }),
      el('button', { text: '✕', title: 'Remove panel', onclick: () => removePanel(p) }));
    if (p.span > 1) root.classList.add('span-full');
    const body = el('div', { class: 'panel-body' });
    root.append(head, body);
    if (p.type === 'chart') buildChart(p, root, body);
    else if (p.type === 'values') buildValues(p, root, body);
    else if (p.type === 'track') buildTrack(p, root, body);
    else if (p.type === 'info') buildInfo(p, body);
    S.panelEls.set(p.id, root);
    return root;
  }

  function seriesPicker(p, onPick) {
    const sel = el('select', { title: 'Add a data series to this panel' });
    sel.append(el('option', { value: '', text: '+ series' }));
    for (const s of numericStreams()) {
      const g = el('optgroup', { label: `${s.id} — ${s.name} (${s.rate.toFixed(s.rate < 10 ? 1 : 0)} Hz)` });
      s.labels.forEach((l, c) => g.append(el('option', { value: s.id + '|' + c, text: (l || s.key) + (s.units[c] ? ' [' + s.units[c] + ']' : '') })));
      if (s.comps > 1) g.append(el('option', { value: s.id + '|*', text: 'all components' }));
      sel.append(g);
    }
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const [id, c] = sel.value.split('|');
      const s = S.streams[id];
      const refs = c === '*' ? s.labels.map((_, i) => ({ stream: id, comp: i })).filter(r => s.labels[r.comp] !== '|magnitude|') : [{ stream: id, comp: parseInt(c, 10) }];
      onPick(refs); sel.value = '';
    });
    return sel;
  }
  function chips(p, onChange) {
    const foot = el('div', { class: 'panel-foot' });
    (p.series || []).forEach((ref, i) => {
      const ok = !!(S.streams[ref.stream] && ref.comp < S.streams[ref.stream].comps);
      const color = ref.color || cssVar(PALETTE[i % PALETTE.length]);
      const ci = el('input', { type: 'color', value: toHex(color), title: 'Series color' });
      ci.addEventListener('input', () => { ref.color = ci.value; onChange(false); });
      const unit = ok ? (S.streams[ref.stream].units[ref.comp] || '') : '';
      const chip = el('span', { class: 'chip' + (ok ? '' : ' missing'), title: ok ? `${S.streams[ref.stream].name} — ${seriesLabel(ref)}` : 'Stream not present in this file' }, ci,
        el('span', { class: 'legend-lbl', text: seriesLabel(ref) + (unit ? ' [' + unit + ']' : '') }),
        el('button', { class: 'x', text: '✕', title: 'Remove series', onclick: () => { p.series.splice(i, 1); onChange(true); } }));
      foot.append(chip);
    });
    foot.append(seriesPicker(p, refs => { p.series = (p.series || []).concat(refs); onChange(true); }));
    return foot;
  }
  function toHex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    if (!m) return '#888888';
    return '#' + [m[1], m[2], m[3]].map(x => parseInt(x, 10).toString(16).padStart(2, '0')).join('');
  }

  function buildChart(p, root, body) {
    const ch = new TimeChart(body, {
      yMode: p.ymode || 'auto', showPoints: p.points || 'auto',
      onSeek: t => { S.rev = false; seek(t); },
      onViewChange: (t0, t1) => { if (S.link) setView(t0, t1, ch); else { /* independent */ } },
    });
    ch.setFullRange(S.view.t0, S.view.t1);
    const list = (p.series || []).map((r, i) => resolveSeries(r, i)).filter(Boolean);
    // units sanity: mixed units with shared axis → normalize automatically
    const units = new Set(list.map(s => s.unit));
    if (units.size > 1 && (p.ymode || 'auto') !== 'norm' && !p.ymodeUser) { ch.setYMode('norm'); p.ymode = 'norm'; }
    ch.setSeries(list);
    ch.setView(S.view.t0, S.view.t1, true);
    ch.setTrim(hasTrim() ? S.trim : null); ch.setMarkers(S.markers); ch.setCursorVisible(S.cursorOn);
    S.charts.set(p.id, ch);
    const foot = chips(p, rebuild => { if (rebuild) rerenderPanel(p); else ch.setSeries((p.series || []).map((r, i) => resolveSeries(r, i)).filter(Boolean)); saveLayout(); });
    const ym = el('select', { class: 'ymode', title: 'Y axis: auto-range the visible data, use the full-data range, or normalize each series to 0–100% (for overlaying different units)' });
    for (const [v, l] of [['auto', 'Y auto'], ['full', 'Y full'], ['norm', 'Y norm']]) ym.append(el('option', { value: v, text: l }));
    ym.value = p.ymode || 'auto';
    ym.addEventListener('change', () => { p.ymode = ym.value; p.ymodeUser = true; ch.setYMode(p.ymode); saveLayout(); });
    const pts = el('select', { class: 'pts', title: 'Show sample points' });
    for (const [v, l] of [['auto', 'pts auto'], ['on', 'pts on'], ['off', 'pts off']]) pts.append(el('option', { value: v, text: l }));
    pts.value = p.points || 'auto';
    pts.addEventListener('change', () => { p.points = pts.value; ch.setShowPoints(p.points); saveLayout(); });
    const fit = el('button', { text: '⤢', title: 'Reset zoom to the full range (double-click the chart does the same)', onclick: () => ch.resetView() });
    const trimBtn = el('button', { text: '⟦⟧', title: 'Zoom to the trim range', onclick: () => { if (hasTrim()) setView(S.trim.in, S.trim.out, null); } });
    foot.append(el('span', { class: 'spacer' }), ym, pts, fit, trimBtn);
    root.append(foot);
  }
  function setView(t0, t1, source) {
    S.view = { t0, t1 };
    for (const ch of S.charts.values()) if (ch !== source && S.link) ch.setView(t0, t1, true);
    if (source && !S.link) source.setView(t0, t1, true);
  }

  function buildValues(p, root, body) {
    const grid = el('div', { class: 'values' });
    body.append(grid);
    root.append(chips(p, () => rerenderPanel(p)));
    const tiles = [];
    (p.series || []).forEach((ref, i) => {
      const s = resolveSeries(ref, i);
      if (!s) return;
      const v = el('span', { class: 'v', text: '—' });
      const tile = el('div', { class: 'vtile', style: 'border-left-color:' + s.color }, el('div', {}, v, el('span', { class: 'u', text: s.unit })), el('div', { class: 'l', text: s.label, title: s.label }));
      grid.append(tile); tiles.push({ s, v, last: '' });
    });
    if (!tiles.length) grid.append(el('div', { class: 'empty', text: 'Add series with “+ series” to show live values at the playhead.' }));
    body._tiles = tiles;
  }
  function updateValuePanels(t) {
    for (const [id, root] of S.panelEls) {
      if (root.dataset.type !== 'values') continue;
      const tiles = root.querySelector('.panel-body')._tiles || [];
      for (const tile of tiles) {
        const i = TimeChart.nearestIndex(tile.s.times, t);
        const txt = i >= 0 ? TimeChart.fmtVal(tile.s.values[i]) : '—';
        if (txt !== tile.last) { tile.v.textContent = txt; tile.last = txt; }
      }
    }
  }

  function buildTrack(p, root, body) {
    const cv = el('canvas', { class: 'track-canvas' });
    body.append(cv);
    const s = S.streams[p.stream];
    const st = { cv, s, pts: null, bounds: null };
    if (s) {
      const lat = s.cols[0], lon = s.cols[1];
      let lat0 = NaN, lon0 = NaN;
      for (let i = 0; i < s.count; i++) if (lat[i] !== 0 && lon[i] !== 0 && lat[i] === lat[i]) { lat0 = lat[i]; lon0 = lon[i]; break; }
      if (lat0 === lat0) {
        const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
        const xs = new Float64Array(s.count), ys = new Float64Array(s.count);
        let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
        for (let i = 0; i < s.count; i++) {
          if (lat[i] === 0 && lon[i] === 0) { xs[i] = NaN; ys[i] = NaN; continue; }
          xs[i] = (lon[i] - lon0) * kx; ys[i] = (lat[i] - lat0) * ky;
          if (xs[i] < minx) minx = xs[i]; if (xs[i] > maxx) maxx = xs[i]; if (ys[i] < miny) miny = ys[i]; if (ys[i] > maxy) maxy = ys[i];
        }
        st.pts = { xs, ys }; st.bounds = { minx, maxx, miny, maxy };
      }
    }
    body._track = st;
    new ResizeObserver(() => drawTrack(st, currentTime())).observe(body);
    drawTrack(st, currentTime());
  }
  function drawTrack(st, t) {
    const cv = st.cv; const r = cv.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
    ctx.font = '11px ' + cssVar('--font'); ctx.fillStyle = cssVar('--text-secondary');
    if (!st.pts) { ctx.textAlign = 'center'; ctx.fillText('No GPS fix in this file', r.width / 2, r.height / 2); return; }
    const b = st.bounds, pad = 16;
    const sx = (r.width - 2 * pad) / Math.max(1, b.maxx - b.minx), sy = (r.height - 2 * pad) / Math.max(1, b.maxy - b.miny);
    const k = Math.min(sx, sy);
    const ox = pad + ((r.width - 2 * pad) - (b.maxx - b.minx) * k) / 2, oy = pad + ((r.height - 2 * pad) - (b.maxy - b.miny) * k) / 2;
    const X = x => ox + (x - b.minx) * k, Y = y => r.height - (oy + (y - b.miny) * k);
    const { xs, ys } = st.pts; const times = st.s.times;
    const path = (lo, hi) => { ctx.beginPath(); let pen = false; for (let i = 0; i < xs.length; i++) { if (xs[i] !== xs[i] || times[i] < lo || times[i] > hi) { pen = false; continue; } if (!pen) { ctx.moveTo(X(xs[i]), Y(ys[i])); pen = true; } else ctx.lineTo(X(xs[i]), Y(ys[i])); } ctx.stroke(); };
    ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.strokeStyle = cssVar('--axis'); path(-Infinity, Infinity);
    if (hasTrim()) { ctx.strokeStyle = cssVar('--s1'); path(S.trim.in, S.trim.out); } else { ctx.strokeStyle = cssVar('--s1'); path(-Infinity, Infinity); }
    // scale bar
    const meters = TimeChart.niceStep((r.width - 2 * pad) / k / 4, 1);
    ctx.fillStyle = cssVar('--text-secondary'); ctx.fillRect(pad, r.height - 8, meters * k, 2); ctx.textAlign = 'left'; ctx.fillText(meters >= 1000 ? (meters / 1000) + ' km' : meters + ' m', pad, r.height - 11);
    // cursor
    const i = TimeChart.nearestIndex(times, t);
    if (i >= 0 && xs[i] === xs[i]) { ctx.fillStyle = cssVar('--cursor'); ctx.strokeStyle = cssVar('--surface-1'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(xs[i]), Y(ys[i]), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }
  function updateTrackPanels(t) { for (const root of S.panelEls.values()) if (root.dataset.type === 'track') { const st = root.querySelector('.panel-body')._track; if (st) drawTrack(st, t); } }

  function buildInfo(p, body) {
    const d = el('div', { class: 'info' });
    body.append(d);
    const info = S.info;
    if (!info) { d.append(el('div', { class: 'muted', text: 'Open a file to see its details.' })); return; }
    const kv = (rows) => { const t = el('table'); for (const [k, v] of rows) if (v != null && v !== '') t.append(el('tr', {}, el('td', { class: 'k', text: k }), el('td', { text: String(v) }))); return t; };
    d.append(el('h4', { text: 'File' }), kv([['Name', info.fileName], ['Size', (info.fileSize / 1e6).toFixed(1) + ' MB'], ['Brand', info.brand], ['Duration', info.duration.toFixed(3) + ' s'], ['Created', info.creation ? info.creation.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : ''],
      ['Video', info.video ? `${info.video.width}×${info.video.height} ${info.video.codec} @ ${info.video.fps.toFixed(3)} fps, ${info.video.frames} frames${info.video.rotation ? ', rotated ' + info.video.rotation + '°' : ''}` : 'none'],
      ['Audio', info.audio ? info.audio.codec : 'none'], ['Telemetry', info.gpmd ? `${info.gpmd.sampleCount} payloads, ${(info.gpmd.bytes / 1e6).toFixed(2)} MB` : 'none']]));
    const u = info.udta || {};
    const urows = Object.entries(u).filter(([k]) => k !== 'GPMF').map(([k, v]) => [k, v]);
    if (urows.length) d.append(el('h4', { text: 'GoPro metadata (udta)' }), kv(urows));
    if (u.GPMF) {
      try { const flat = GPMF.flatten(u.GPMF).filter(x => x.value); d.append(el('h4', { text: 'Global GPMF' }), kv(flat.slice(0, 60).map(x => [x.key, x.value]))); } catch (e) { /* ignore */ }
    }
    const st = streamsSorted();
    if (st.length) {
      const t = el('table'); t.append(el('tr', {}, ...['Key', 'Name', 'Rate', 'Samples', 'Components', 'Units'].map(h => el('th', { text: h }))));
      for (const s of st) t.append(el('tr', {}, el('td', { class: 'mono', text: s.id }), el('td', { text: s.name }), el('td', { text: s.rate.toFixed(s.rate < 10 ? 2 : 1) + ' Hz' }), el('td', { text: String(s.count) }), el('td', { text: s.labels.join(', ') }), el('td', { text: [...new Set(s.units)].join(', ') })));
      d.append(el('h4', { text: 'Telemetry streams' }), t);
    }
  }

  // dashboard toolbar
  $('presetSelect').addEventListener('change', e => { if (!e.target.value) return; S.layout = makePreset(e.target.value); renderDashboard(); e.target.value = ''; });
  $('colsSelect').addEventListener('change', e => { S.layout.cols = parseInt(e.target.value, 10); renderDashboard(); });
  $('btnAddPanel').addEventListener('click', () => {
    const sel = el('select');
    for (const [v, l] of [['chart', 'Chart — time series (overlay any streams)'], ['values', 'Values — live readout at the playhead'], ['track', 'Track — GPS path (needs GPS5/GPS9)'], ['info', 'Info — file & stream details']]) sel.append(el('option', { value: v, text: l }));
    const ttl = el('input', { type: 'text', value: 'New panel' });
    dialog({ title: 'Add panel', body: el('div', {}, el('label', {}, 'Type', sel), el('label', {}, 'Title', ttl)), buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => { S.layout.panels.push({ id: newId(), type: sel.value, title: ttl.value, series: [], ymode: 'auto', span: 1, h: 'm' }); renderDashboard(); } }] });
  });
  $('btnExportLayout').addEventListener('click', () => download(new Blob([JSON.stringify(S.layout, null, 2)], { type: 'application/json' }), 'heroscope-dashboard.json'));
  $('btnImportLayout').addEventListener('click', () => $('layoutInput').click());
  $('layoutInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const l = JSON.parse(await f.text()); if (!Array.isArray(l.panels)) throw new Error('no panels'); l.panels.forEach(p => { p.id = p.id || newId(); }); S.layout = { cols: l.cols || 2, panels: l.panels }; renderDashboard(); toast('Dashboard imported'); }
    catch (err) { toast('Invalid layout file: ' + err.message); }
    e.target.value = '';
  });
  function saveLayout() { try { localStorage.setItem(LS_LAYOUT, JSON.stringify(S.layout)); } catch (e) { /* ignore */ } }
  function loadLayout() { try { const l = JSON.parse(localStorage.getItem(LS_LAYOUT)); if (l && Array.isArray(l.panels)) S.layout = l; } catch (e) { /* ignore */ } }

  // graph toggles
  $('btnCursor').addEventListener('click', () => { S.cursorOn = !S.cursorOn; $('btnCursor').classList.toggle('on', S.cursorOn); for (const ch of S.charts.values()) ch.setCursorVisible(S.cursorOn); savePrefs(); });
  $('btnFollow').addEventListener('click', () => { S.follow = !S.follow; $('btnFollow').classList.toggle('on', S.follow); savePrefs(); });
  $('btnLink').addEventListener('click', () => { S.link = !S.link; $('btnLink').classList.toggle('on', S.link); if (S.link) for (const ch of S.charts.values()) ch.setView(S.view.t0, S.view.t1, true); savePrefs(); });

  // ---------------- capture
  async function exportFrame() {
    if (!S.file || !video.videoWidth) { toast('No decodable video frame to export'); return; }
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(video, 0, 0, c.width, c.height); } catch (e) { toast('Cannot read frame: ' + e.message); return; }
    const t = currentTime(), f = frameOf(t);
    if (S.burnTc) {
      const fs = Math.max(16, Math.round(c.height / 32));
      ctx.font = `600 ${fs}px ${cssVar('--mono')}`; ctx.textBaseline = 'bottom';
      const txt = `${timecode(t)}  F${f}  ${t.toFixed(3)}s`;
      const w = ctx.measureText(txt).width + fs;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(fs / 2, c.height - fs * 2, w, fs * 1.5);
      ctx.fillStyle = '#fff'; ctx.fillText(txt, fs, c.height - fs * 0.75);
    }
    c.toBlob(b => { if (b) { download(b, `${baseName()}_f${String(f).padStart(6, '0')}_${timecode(t).replace(/:/g, '-')}.png`); toast(`Saved frame ${f} (${c.width}×${c.height})`); } }, 'image/png');
  }
  async function screenshotUI() {
    const root = $('app'); const r = root.getBoundingClientRect();
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement('canvas'); c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
    const ctx = c.getContext('2d'); ctx.scale(scale, scale);
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor; ctx.fillRect(0, 0, r.width, r.height);
    const transparent = bg => !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg);
    const rr = (x, y, w, h, rad) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, rad) : ctx.rect(x, y, w, h); };
    const drawText = (text, cs, rect, align) => {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const x = rect.left - r.left + (align === 'center' ? rect.width / 2 - ctx.measureText(text).width / 2 : 0);
      ctx.fillText(text, x, rect.top - r.top + rect.height / 2);
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        const text = node.textContent.replace(/\s+/g, ' ').trim(); if (!text) return;
        const range = document.createRange(); range.selectNodeContents(node);
        const rects = range.getClientRects(); if (!rects.length) return;
        const cs = getComputedStyle(node.parentElement);
        const lines = text.split(' ');
        if (rects.length === 1) drawText(text, cs, rects[0]); else { // wrapped text: approximate by distributing words across line boxes
          let li = 0, buf = ''; ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          for (const w of lines) { const cand = buf ? buf + ' ' + w : w; if (ctx.measureText(cand).width > rects[Math.min(li, rects.length - 1)].width + 2 && buf) { drawText(buf, cs, rects[Math.min(li, rects.length - 1)]); li++; buf = w; } else buf = cand; }
          if (buf) drawText(buf, cs, rects[Math.min(li, rects.length - 1)]);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const elm = node;
      if (elm.id === 'toast' || elm.tagName === 'DIALOG' || elm.classList.contains('tc-tip')) return;
      const cs = getComputedStyle(elm);
      if (cs.display === 'none' || cs.visibility === 'hidden' || elm.hidden) return;
      const b = elm.getBoundingClientRect(); if (b.width <= 0 || b.height <= 0) return;
      const x = b.left - r.left, y = b.top - r.top;
      ctx.save();
      ctx.globalAlpha *= parseFloat(cs.opacity) || 1;
      const rad = parseFloat(cs.borderTopLeftRadius) || 0;
      if (!transparent(cs.backgroundColor)) { ctx.fillStyle = cs.backgroundColor; rr(x, y, b.width, b.height, rad); ctx.fill(); }
      const bw = parseFloat(cs.borderTopWidth) || 0;
      if (bw > 0 && cs.borderTopStyle !== 'none' && !transparent(cs.borderTopColor)) { ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = bw; rr(x + bw / 2, y + bw / 2, b.width - bw, b.height - bw, rad); ctx.stroke(); }
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      if (bl > 0 && bw === 0 && !transparent(cs.borderLeftColor)) { ctx.fillStyle = cs.borderLeftColor; ctx.fillRect(x, y, bl, b.height); }
      if (cs.overflow !== 'visible' || elm.id === 'videoWrap') { rr(x, y, b.width, b.height, rad); ctx.clip(); }
      if (elm.tagName === 'VIDEO') {
        if (elm.videoWidth) { const k = Math.min(b.width / elm.videoWidth, b.height / elm.videoHeight); const w = elm.videoWidth * k, h = elm.videoHeight * k; try { ctx.drawImage(elm, x + (b.width - w) / 2, y + (b.height - h) / 2, w, h); } catch (e) { /* tainted */ } }
      } else if (elm.tagName === 'CANVAS') { ctx.drawImage(elm, x, y, b.width, b.height); }
      else if (elm.tagName === 'INPUT') {
        if (elm.type === 'range') { ctx.fillStyle = cs.color; ctx.globalAlpha *= 0.5; ctx.fillRect(x, y + b.height / 2 - 1, b.width, 2); ctx.globalAlpha /= 0.5; const p = (parseFloat(elm.value) - parseFloat(elm.min)) / (parseFloat(elm.max) - parseFloat(elm.min)); ctx.fillStyle = cssVar('--accent'); ctx.beginPath(); ctx.arc(x + p * b.width, y + b.height / 2, 6, 0, Math.PI * 2); ctx.fill(); }
        else if (elm.type === 'checkbox') { ctx.strokeStyle = cs.color; ctx.lineWidth = 1; ctx.strokeRect(x + 1, y + 1, b.width - 2, b.height - 2); if (elm.checked) { ctx.fillStyle = cssVar('--accent'); ctx.fillRect(x + 3, y + 3, b.width - 6, b.height - 6); } }
        else if (elm.type === 'color') { ctx.fillStyle = elm.value; ctx.fillRect(x + 1, y + 1, b.width - 2, b.height - 2); }
        else if (elm.type === 'text') drawText(elm.value, cs, { left: b.left + 5, top: b.top, width: b.width - 10, height: b.height });
      } else if (elm.tagName === 'SELECT') { const o = elm.options[elm.selectedIndex]; if (o) drawText(o.text, cs, { left: b.left + 6, top: b.top, width: b.width - 12, height: b.height }); }
      else for (const ch of elm.childNodes) walk(ch);
      ctx.restore();
    };
    walk(root);
    const t = currentTime();
    c.toBlob(b => { if (b) { download(b, `${baseName()}_heroscope_${timecode(t).replace(/:/g, '-')}.png`); toast('Interface screenshot saved'); } }, 'image/png');
  }
  async function screenshotExact() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Screen capture is not available in this browser'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' }); }
    catch (e) { toast('Screen capture cancelled'); return; }
    const v = document.createElement('video'); v.srcObject = stream; v.muted = true;
    await v.play();
    await new Promise(r => setTimeout(r, 300));
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    stream.getTracks().forEach(t => t.stop());
    c.toBlob(b => { if (b) { download(b, `${baseName()}_screen_${timecode(currentTime()).replace(/:/g, '-')}.png`); toast('Screen capture saved'); } }, 'image/png');
  }
  $('btnFrame').addEventListener('click', exportFrame);
  $('btnScreenshot').addEventListener('click', e => { if (e.shiftKey) screenshotExact(); else screenshotUI(); });

  // ---------------- exports
  function exportCsvDialog() {
    const st = numericStreams();
    if (!st.length) { toast('No telemetry streams loaded'); return; }
    const sel = el('select');
    for (const s of st) sel.append(el('option', { value: s.id, text: `${s.id} — ${s.name} (${s.count} samples)` }));
    const trimOnly = el('input', { type: 'checkbox' }); trimOnly.checked = hasTrim();
    dialog({ title: 'Export CSV', body: el('div', {}, el('label', {}, 'Stream', sel), el('label', { class: 'chk' }, trimOnly, ' Only the trimmed range')),
      buttons: [{ label: 'Cancel' }, { label: 'Download CSV', primary: true, onClick: () => exportCsv(S.streams[sel.value], trimOnly.checked) }] });
  }
  function exportCsv(s, trimOnly) {
    const lo = trimOnly && hasTrim() ? S.trim.in : -Infinity, hi = trimOnly && hasTrim() ? S.trim.out : Infinity;
    const head = ['time_s', 'frame'].concat(s.labels.map((l, i) => (s.key + (l ? '_' + l : '')).replace(/[^\w|]+/g, '_') + (s.units[i] ? ' [' + s.units[i] + ']' : '')));
    const rows = [head.join(',')];
    for (let i = 0; i < s.count; i++) {
      const t = s.times[i]; if (t < lo || t > hi) continue;
      const vals = s.cols.map(c => { const v = c[i]; return v === v ? (Number.isInteger(v) ? String(v) : v.toPrecision(9).replace(/\.?0+$/, '')) : ''; });
      rows.push([t.toFixed(6), frameOf(t)].concat(vals).join(','));
    }
    download(new Blob([rows.join('\n')], { type: 'text/csv' }), `${baseName()}_${s.id.replace('@', '_')}${trimOnly && hasTrim() ? '_trim' : ''}.csv`);
    toast(`Exported ${rows.length - 1} rows`);
  }
  $('btnExportCsv').addEventListener('click', exportCsvDialog);
  function exportTrimDialog() {
    if (!S.file) { toast('Open a file first'); return; }
    const fi = frameOf(S.trim.in), fo = Math.round(S.trim.out * S.fps);
    const obj = { file: S.file.name, fps: S.fps, in_s: +S.trim.in.toFixed(6), out_s: +S.trim.out.toFixed(6), in_frame: fi, out_frame: fo, frames: fo - fi, in_tc: timecode(S.trim.in), out_tc: timecode(S.trim.out - 0.5 / S.fps), markers: S.markers.map(m => ({ label: m.label, t: +m.t.toFixed(6), frame: frameOf(m.t), tc: timecode(m.t) })) };
    const q = s => '"' + s.replace(/"/g, '\\"') + '"';
    const cmdCopy = `ffmpeg -ss ${obj.in_s} -to ${obj.out_s} -i ${q(S.file.name)} -map 0 -c copy -copyts ${q(baseName() + '_trim.mp4')}`;
    const cmdExact = `ffmpeg -ss ${obj.in_s} -to ${obj.out_s} -i ${q(S.file.name)} -map 0:v -map 0:a? -c:v libx264 -crf 18 -c:a copy ${q(baseName() + '_trim_exact.mp4')}`;
    const pre = el('pre', { text: JSON.stringify(obj, null, 2) });
    const body = el('div', {}, el('p', { text: 'The trim is virtual — nothing is written to the original file. Use the JSON for your own tooling, or one of these ffmpeg commands to cut the file:' }),
      el('p', { class: 'muted', text: 'Stream-copy (fast, keeps GPMF telemetry, cuts on keyframes):' }), el('pre', { text: cmdCopy }),
      el('p', { class: 'muted', text: 'Frame-exact re-encode (drops the telemetry track):' }), el('pre', { text: cmdExact }), pre);
    dialog({ title: 'Export trim', body, buttons: [{ label: 'Close' }, { label: 'Copy ffmpeg (copy)', onClick: () => { navigator.clipboard && navigator.clipboard.writeText(cmdCopy); toast('Copied'); return false; } }, { label: 'Download JSON', primary: true, onClick: () => download(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), `${baseName()}_trim.json`) }] });
  }
  $('btnExportTrim').addEventListener('click', exportTrimDialog);

  // ---------------- help
  function help() {
    const keys = [['Space', 'Play / pause'], ['J / K / L', 'Reverse / pause / forward'], ['← / →', 'Previous / next frame'], ['Shift+← / →', '±10 frames'], ['Home / End', 'Start / end (of trim)'], ['↑ / ↓', 'Faster / slower'], ['I / O', 'Set in / out point'], ['Shift+I / O', 'Jump to in / out'], ['M', 'Add marker'], [', / .', 'Previous / next marker'], ['C', 'Toggle cursor line on graphs'], ['F', 'Save full-resolution frame PNG'], ['S', 'Screenshot the interface (Shift: exact screen capture)'], ['Ctrl+O', 'Open file'], ['?', 'This help']];
    const t = el('table', { class: 'keys' });
    for (const [k, d] of keys) t.append(el('tr', {}, el('td', {}, el('kbd', { text: k })), el('td', { text: d })));
    const body = el('div', {}, el('p', { text: 'HeroScope reads GoPro MP4 files entirely in your browser: the video plays natively and the GPMF telemetry track (accelerometer, gyroscope, GPS, orientation, exposure…) is decoded into graphs. Nothing is uploaded.' }),
      el('p', { text: 'Graphs: wheel to zoom, drag to pan, click to seek the video, double-click to reset. Hover for values of every series at that time. The red line is the current video frame.' }),
      el('p', { text: 'Dashboard: add panels, overlay any streams on one chart (mixed units are normalized automatically), resize, reorder, and export/import the layout as JSON. The layout is remembered in this browser.' }),
      el('p', { text: 'Video: wheel over the picture to zoom (drag to pan, double-click to reset). The trim is virtual: set in/out points and the transport loops inside them; export the cut points as JSON or an ffmpeg command.' }), t);
    dialog({ title: 'HeroScope help', body });
  }
  $('btnHelp').addEventListener('click', help);

  // ---------------- keyboard
  document.addEventListener('keydown', e => {
    if (isTyping()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    switch (k) {
      case ' ': togglePlay(); break;
      case 'ArrowLeft': step(e.shiftKey ? -10 : -1); break;
      case 'ArrowRight': step(e.shiftKey ? 10 : 1); break;
      case 'ArrowUp': speedStep(1); break;
      case 'ArrowDown': speedStep(-1); break;
      case 'Home': pause(); seek(hasTrim() ? S.trim.in : 0); break;
      case 'End': pause(); seekFrame((hasTrim() ? frameOf(S.trim.out) : S.frames) - 1); break;
      case 'j': case 'J': if (S.rev) setSpeed(S.speed * 2); else playReverse(); break;
      case 'k': case 'K': pause(); break;
      case 'l': case 'L': if (!video.paused && !S.rev) setSpeed(S.speed * 2); else play(); break;
      case 'i': setIn(); break;
      case 'o': setOut(); break;
      case 'I': seek(S.trim.in + 0.5 / S.fps); break;
      case 'O': seek(S.trim.out - 0.5 / S.fps); break;
      case 'm': case 'M': addMarker(); break;
      case ',': gotoMarker(-1); break;
      case '.': gotoMarker(1); break;
      case 'c': case 'C': $('btnCursor').click(); break;
      case 'f': case 'F': exportFrame(); break;
      case 's': screenshotUI(); break;
      case 'S': screenshotExact(); break;
      case '?': help(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ---------------- layout: splitter, theme, prefs
  (function () {
    const sp = $('splitter'), pane = $('videoPane'); let d = null;
    sp.addEventListener('pointerdown', e => { d = { x: e.clientX, w: pane.getBoundingClientRect().width }; sp.setPointerCapture(e.pointerId); });
    sp.addEventListener('pointermove', e => { if (!d) return; const w = clamp(d.w + e.clientX - d.x, 320, window.innerWidth - 300); pane.style.width = w + 'px'; });
    sp.addEventListener('pointerup', () => { d = null; savePrefs(); });
  })();
  function setTheme(t) { document.documentElement.dataset.theme = t; for (const ch of S.charts.values()) ch.draw(); drawTimeline(); updateTrackPanels(currentTime()); }
  $('btnTheme').addEventListener('click', () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); savePrefs(); });
  function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify({ cursorOn: S.cursorOn, follow: S.follow, link: S.link, hud: S.hud, burnTc: S.burnTc, theme: document.documentElement.dataset.theme, paneWidth: $('videoPane').style.width })); } catch (e) { /* ignore */ } }
  function loadPrefs() {
    let p = null; try { p = JSON.parse(localStorage.getItem(LS_PREFS)); } catch (e) { /* ignore */ }
    if (!p) { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) setTheme('light'); return; }
    if (p.cursorOn === false) { S.cursorOn = false; $('btnCursor').classList.remove('on'); }
    if (p.follow === false) { S.follow = false; $('btnFollow').classList.remove('on'); }
    if (p.link === false) { S.link = false; $('btnLink').classList.remove('on'); }
    if (p.hud === false) { S.hud = false; $('tHud').classList.remove('on'); }
    if (p.burnTc) { S.burnTc = true; $('burnTc').checked = true; }
    if (p.theme) setTheme(p.theme);
    if (p.paneWidth) $('videoPane').style.width = p.paneWidth;
  }
  loadPrefs(); loadLayout(); setSpeed(1); drawTimeline();
  if (S.layout.panels.length) renderDashboard();
  window.HeroScope = { state: S, openFile, seek, step, setView, makePreset, renderDashboard, exportFrame, screenshotUI, version: '0.1.0' };
})();
