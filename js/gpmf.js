/* HeroScope — GPMF (GoPro Metadata Format) parser.
 * Parses the KLV tree of each "gpmd" payload and flattens sensor streams
 * (ACCL, GYRO, GPS5/GPS9, GRAV, CORI, …) into typed arrays with timestamps.
 */
'use strict';
var GPMF = (function () {
  const TYPE_SIZES = { b: 1, B: 1, c: 1, d: 8, f: 4, F: 4, G: 16, j: 8, J: 8, l: 4, L: 4, q: 4, Q: 8, s: 2, S: 2, U: 16 };
  // Keys inside a STRM that describe the stream rather than carry its samples.
  const META = new Set(['STNM', 'SIUN', 'UNIT', 'SCAL', 'ORIN', 'ORIO', 'TSMP', 'TMPC', 'STMP', 'TYPE', 'TICK', 'TOCK', 'MTRX',
    'RMRK', 'STPS', 'TIMO', 'ALLD', 'QUAN', 'VPTS', 'MTYP', 'KLVO', 'FCNM', 'DVID', 'DVNM', 'EMPT']);
  // Known component labels for common streams (used when STNM/ORIN do not say).
  const LABELS = {
    GPS5: ['lat', 'lon', 'alt', 'speed 2D', 'speed 3D'],
    GPS9: ['lat', 'lon', 'alt', 'speed 2D', 'speed 3D', 'days since 2000', 'secs since midnight', 'DOP', 'fix'],
    CORI: ['w', 'x', 'y', 'z'], IORI: ['w', 'x', 'y', 'z'],
    GRAV: ['x', 'y', 'z'], MAGN: ['x', 'y', 'z'],
    WRGB: ['r', 'g', 'b'], HUES: ['hue', 'weight'],
    MSKP: ['x', 'y'], LSKP: ['x', 'y'],
  };
  const latin1 = new TextDecoder('latin1');

  function fourcc(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }
  function isKey(s) { return /^[A-Za-z0-9 _\-]{4}$/.test(s); }

  /** Parse a KLV node list from dv[start,end). */
  function parse(dv, start, end) {
    const nodes = [];
    let off = start;
    while (off + 8 <= end) {
      const key = fourcc(dv, off);
      if (!isKey(key)) break;
      const type = dv.getUint8(off + 4);
      const size = dv.getUint8(off + 5);
      const repeat = dv.getUint16(off + 6);
      const length = size * repeat;
      const dataStart = off + 8;
      if (dataStart + length > end) break;
      const node = { key, type: type === 0 ? null : String.fromCharCode(type), size, repeat, dataStart, length, dv };
      if (type === 0) node.children = parse(dv, dataStart, dataStart + length);
      nodes.push(node);
      off = dataStart + ((length + 3) & ~3);
    }
    return nodes;
  }

  function readScalar(dv, p, t) {
    switch (t) {
      case 'b': return dv.getInt8(p);
      case 'B': return dv.getUint8(p);
      case 'c': return String.fromCharCode(dv.getUint8(p));
      case 'd': return dv.getFloat64(p);
      case 'f': return dv.getFloat32(p);
      case 'F': return fourcc(dv, p);
      case 'j': return Number(dv.getBigInt64(p));
      case 'J': return Number(dv.getBigUint64(p));
      case 'l': return dv.getInt32(p);
      case 'L': return dv.getUint32(p);
      case 'q': return dv.getInt32(p) / 65536;
      case 'Q': return Number(dv.getBigInt64(p)) / 4294967296;
      case 's': return dv.getInt16(p);
      case 'S': return dv.getUint16(p);
      case 'U': return latin1.decode(new Uint8Array(dv.buffer, dv.byteOffset + p, 16));
      case 'G': { let s = ''; for (let i = 0; i < 16; i++) s += dv.getUint8(p + i).toString(16).padStart(2, '0'); return s; }
      default: return null;
    }
  }

  /** Expand a TYPE string like "LffffF" or "c[4]l" into a list of type chars. */
  function expandType(t) {
    const out = [];
    const re = /([a-zA-Z?])(?:\[(\d+)\])?/g;
    let m;
    while ((m = re.exec(t))) { const n = m[2] ? parseInt(m[2], 10) : 1; for (let i = 0; i < n; i++) out.push(m[1]); }
    return out;
  }

  /** Decode a node's data into an array of samples (each an array of components, or a string). */
  function values(node, complexType) {
    const { dv, type, size, repeat, dataStart } = node;
    if (type === null) return [];
    if (type === 'c') {
      // repeat strings of `size` chars
      const out = [];
      for (let r = 0; r < repeat; r++) {
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset + dataStart + r * size, size);
        out.push(latin1.decode(bytes).replace(/\0.*$/s, '').trim());
      }
      return out;
    }
    if (type === 'U' || type === 'F' || type === 'G') {
      const out = [];
      for (let r = 0; r < repeat; r++) out.push(readScalar(dv, dataStart + r * size, type));
      return out;
    }
    if (type === '?') {
      const types = expandType(complexType || '');
      if (!types.length) return [];
      const out = [];
      for (let r = 0; r < repeat; r++) {
        let p = dataStart + r * size;
        const sample = [];
        for (const t of types) {
          const w = TYPE_SIZES[t] || 0;
          if (p + w > dataStart + (r + 1) * size) break;
          sample.push(readScalar(dv, p, t));
          p += w;
        }
        out.push(sample);
      }
      return out;
    }
    const w = TYPE_SIZES[type];
    if (!w) return [];
    const comps = Math.max(1, Math.floor(size / w));
    const out = new Array(repeat);
    for (let r = 0; r < repeat; r++) {
      const s = new Array(comps);
      const base = dataStart + r * size;
      for (let c = 0; c < comps; c++) s[c] = readScalar(dv, base + c * w, type);
      out[r] = s;
    }
    return out;
  }

  function first(nodes, key) { return nodes.find(n => n.key === key); }
  function str(node) { return node ? values(node).join('') : ''; }
  function strList(node) { return node ? values(node) : []; }

  function labelsFor(key, stnm, orin, comps) {
    const m = /\(([^)]*)\)/.exec(stnm || '');
    if (m) {
      const parts = m[1].split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === comps) return parts;
    }
    if (LABELS[key] && LABELS[key].length === comps) return LABELS[key];
    if (orin && orin.length === comps) return orin.split('').map(c => c.toUpperCase());
    if (comps === 3) return ['X', 'Y', 'Z'];
    if (comps === 1) return [''];
    return Array.from({ length: comps }, (_, i) => 'c' + i);
  }

  /**
   * Extract streams from decoded payloads.
   * payloads: [{buffer, byteOffset, byteLength, time, duration}]
   * returns { streams: {key: Stream}, devices: [...] }
   */
  function extract(payloads, onProgress) {
    const acc = {}; // key -> accumulator
    const devices = {};
    const nP = payloads.length;
    for (let pi = 0; pi < nP; pi++) {
      const pl = payloads[pi];
      const dv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
      let roots;
      try { roots = parse(dv, 0, dv.byteLength); } catch (e) { continue; }
      // next payload start gives the true span of this one
      const tStart = pl.time;
      const next = payloads[pi + 1];
      const span = next ? Math.max(1e-6, next.time - tStart) : (pl.duration || 1);
      for (const devc of roots) {
        if (devc.key !== 'DEVC' || !devc.children) continue;
        const dvid = first(devc.children, 'DVID');
        const devId = dvid ? values(dvid)[0][0] : 1;
        const devName = str(first(devc.children, 'DVNM')) || ('Device ' + devId);
        devices[devId] = devName;
        for (const strm of devc.children) {
          if (strm.key !== 'STRM' || !strm.children) continue;
          const kids = strm.children;
          const typeNode = first(kids, 'TYPE');
          const complexType = typeNode ? str(typeNode) : '';
          // candidates for the sample-carrying key
          const cands = kids.filter(k => !META.has(k.key) && k.type !== null && k.type !== 'c' && k.type !== 'U' && k.type !== 'F' && k.type !== 'G' && k.repeat > 0);
          if (!cands.length) continue;
          cands.sort((a, b) => b.repeat - a.repeat);
          const data = cands[0];
          const key = data.key;
          const id = Object.keys(devices).length > 1 || devId !== 1 ? key + '@' + devId : key;
          let a = acc[id];
          const samples = values(data, complexType);
          if (!samples.length) continue;
          if (!a) {
            const comps = Array.isArray(samples[0]) ? samples[0].length : 1;
            const stnm = str(first(kids, 'STNM'));
            const siun = first(kids, 'SIUN'), unit = first(kids, 'UNIT');
            let units = siun ? strList(siun) : (unit ? strList(unit) : []);
            if (units.length === 1 && comps > 1) units = Array(comps).fill(units[0]);
            const orin = str(first(kids, 'ORIN'));
            a = acc[id] = {
              id, key, name: stnm || key, device: { id: devId, name: devName }, comps, units,
              labels: labelsFor(key, stnm, orin, comps), orin, orio: str(first(kids, 'ORIO')),
              type: data.type, complexType, scale: null, times: [], cols: Array.from({ length: comps }, () => []),
              attrs: {}, temps: [], payloads: 0,
            };
            const scal = first(kids, 'SCAL');
            if (scal) { const sv = values(scal).map(v => v[0]); a.scale = sv; }
          }
          // per-payload attributes (GPSU, GPSF, GPSP, TMPC, …)
          for (const k of kids) {
            if (k === data || k.key === 'STNM' || k.key === 'SIUN' || k.key === 'UNIT' || k.key === 'SCAL' || k.key === 'TYPE') continue;
            if (k.type === null) continue;
            const v = values(k);
            if (!v.length) continue;
            if (!a.attrs[k.key]) a.attrs[k.key] = [];
            a.attrs[k.key].push({ t: tStart, v: v.length === 1 ? (Array.isArray(v[0]) && v[0].length === 1 ? v[0][0] : v[0]) : v });
          }
          const n = samples.length;
          const sc = a.scale;
          for (let i = 0; i < n; i++) {
            a.times.push(tStart + (i / n) * span);
            const s = samples[i];
            if (Array.isArray(s)) {
              for (let c = 0; c < a.comps; c++) {
                let v = s[c];
                if (typeof v !== 'number') v = NaN;
                if (sc) { const d = sc.length === 1 ? sc[0] : sc[c]; if (d) v = v / d; }
                a.cols[c].push(v);
              }
            } else {
              a.cols[0].push(typeof s === 'number' ? (sc && sc[0] ? s / sc[0] : s) : NaN);
            }
          }
          a.payloads++;
        }
      }
      if (onProgress && pi % 200 === 0) onProgress('Decoding telemetry… ' + Math.round(100 * pi / nP) + '%');
    }
    const streams = {};
    for (const id of Object.keys(acc)) {
      const a = acc[id];
      const count = a.times.length;
      if (!count) continue;
      const s = {
        id: a.id, key: a.key, name: a.name, device: a.device, comps: a.comps, units: a.units, labels: a.labels,
        orin: a.orin, orio: a.orio, type: a.type, complexType: a.complexType, scale: a.scale, attrs: a.attrs,
        count, times: Float64Array.from(a.times), cols: a.cols.map(c => Float64Array.from(c)),
        t0: a.times[0], t1: a.times[count - 1], payloads: a.payloads,
      };
      s.rate = count > 1 ? (count - 1) / Math.max(1e-9, s.t1 - s.t0) : 0;
      // derived magnitude for 3-axis vector streams
      if (s.comps === 3 && ['ACCL', 'GYRO', 'GRAV', 'MAGN'].includes(s.key)) {
        const m = new Float64Array(count);
        const [x, y, z] = s.cols;
        for (let i = 0; i < count; i++) m[i] = Math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i]);
        s.cols.push(m); s.labels = s.labels.concat(['|magnitude|']); s.units = s.units.concat([s.units[0] || '']); s.comps = 4;
      }
      // GPSU timestamps as a readable attribute
      streams[id] = s;
    }
    return { streams, devices };
  }

  /** Flatten a GPMF buffer (e.g. the udta GPMF box) into [{key, value}] for display. */
  function flatten(buffer) {
    const dv = new DataView(buffer);
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        if (n.children) { out.push({ key: n.key, depth, value: '' }); walk(n.children, depth + 1); continue; }
        let v;
        try { v = values(n); } catch (e) { v = []; }
        let text;
        if (n.type === 'c') text = v.join(' ');
        else text = v.slice(0, 16).map(x => Array.isArray(x) ? x.map(fmt).join(',') : fmt(x)).join(' ') + (v.length > 16 ? ' …' : '');
        out.push({ key: n.key, depth, value: text, type: n.type, repeat: n.repeat });
      }
    };
    const fmt = x => typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toPrecision(5)) : String(x);
    walk(parse(dv, 0, dv.byteLength), 0);
    return out;
  }

  return { parse, values, extract, flatten, expandType, TYPE_SIZES };
})();
if (typeof module !== 'undefined') module.exports = GPMF;
