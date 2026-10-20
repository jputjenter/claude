/* HeroScope — minimal ISO BMFF (MP4/MOV) reader.
 * Reads only what is needed: the moov tree, the GoPro "gpmd" metadata track
 * sample table, video track frame rate / size, and GoPro udta boxes.
 * Works on a File/Blob via slice() so multi‑GB files are never fully loaded.
 */
'use strict';
var MP4 = (function () {
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf']);

  function fourcc(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }
  function isFourcc(s) { return /^[\x20-\x7e]{4}$/.test(s); }
  function latin1(dv, start, end) {
    let s = '';
    for (let i = start; i < end; i++) { const c = dv.getUint8(i); if (c === 0) break; s += String.fromCharCode(c); }
    return s;
  }

  async function readTopLevel(file) {
    const boxes = [];
    let off = 0;
    while (off + 8 <= file.size) {
      const dv = new DataView(await file.slice(off, Math.min(off + 16, file.size)).arrayBuffer());
      let size = dv.getUint32(0);
      const type = fourcc(dv, 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = file.size - off;
      if (size < hdr || !isFourcc(type)) throw new Error('Not a valid MP4/MOV file (bad box at offset ' + off + ')');
      boxes.push({ type, offset: off, size, hdr });
      off += size;
    }
    return boxes;
  }

  function parseBoxes(dv, start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end) {
      let size = dv.getUint32(off);
      const type = fourcc(dv, off + 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; }
      else if (size === 0) size = end - off;
      if (size < hdr || off + size > end || !isFourcc(type)) break;
      const box = { type, start: off, size, dataStart: off + hdr, dataEnd: off + size };
      if (CONTAINERS.has(type)) box.children = parseBoxes(dv, box.dataStart, box.dataEnd);
      else if (type === 'meta') {
        // ISO 'meta' is a FullBox (4 bytes version/flags) — QuickTime's is not. Sniff.
        const probe = box.dataStart + 4 + 4;
        if (probe + 4 <= box.dataEnd && isFourcc(fourcc(dv, probe))) box.children = parseBoxes(dv, box.dataStart + 4, box.dataEnd);
        else box.children = parseBoxes(dv, box.dataStart, box.dataEnd);
      }
      out.push(box);
      off += size;
    }
    return out;
  }

  const find = (children, type) => (children || []).find(b => b.type === type);
  const findAll = (children, type) => (children || []).filter(b => b.type === type);

  function parseStts(dv, box) {
    const n = dv.getUint32(box.dataStart + 4);
    const entries = new Array(n);
    let p = box.dataStart + 8;
    for (let i = 0; i < n; i++, p += 8) entries[i] = { count: dv.getUint32(p), delta: dv.getUint32(p + 4) };
    return entries;
  }
  function parseStsz(dv, box) {
    const uniform = dv.getUint32(box.dataStart + 4);
    const n = dv.getUint32(box.dataStart + 8);
    if (uniform) return { uniform, count: n };
    const sizes = new Uint32Array(n);
    let p = box.dataStart + 12;
    for (let i = 0; i < n; i++, p += 4) sizes[i] = dv.getUint32(p);
    return { uniform: 0, count: n, sizes };
  }
  function parseStsc(dv, box) {
    const n = dv.getUint32(box.dataStart + 4);
    const entries = new Array(n);
    let p = box.dataStart + 8;
    for (let i = 0; i < n; i++, p += 12) entries[i] = { firstChunk: dv.getUint32(p), samplesPerChunk: dv.getUint32(p + 4) };
    return entries;
  }
  function parseStco(dv, box, is64) {
    const n = dv.getUint32(box.dataStart + 4);
    const offs = new Float64Array(n);
    let p = box.dataStart + 8;
    for (let i = 0; i < n; i++) {
      if (is64) { offs[i] = Number(dv.getBigUint64(p)); p += 8; } else { offs[i] = dv.getUint32(p); p += 4; }
    }
    return offs;
  }
  function parseElst(dv, box) {
    const v = dv.getUint8(box.dataStart);
    const n = dv.getUint32(box.dataStart + 4);
    const entries = [];
    let p = box.dataStart + 8;
    for (let i = 0; i < n; i++) {
      if (v === 1) { entries.push({ segmentDuration: Number(dv.getBigUint64(p)), mediaTime: Number(dv.getBigInt64(p + 8)) }); p += 20; }
      else { entries.push({ segmentDuration: dv.getUint32(p), mediaTime: dv.getInt32(p + 4) }); p += 12; }
    }
    return entries;
  }

  const MAC_EPOCH = Date.UTC(1904, 0, 1) / 1000;

  function parseTrack(dv, trak, movieTimescale) {
    const tkhd = find(trak.children, 'tkhd');
    const mdia = find(trak.children, 'mdia');
    if (!tkhd || !mdia) return null;
    const mdhd = find(mdia.children, 'mdhd');
    const hdlr = find(mdia.children, 'hdlr');
    const minf = find(mdia.children, 'minf');
    const stbl = minf && find(minf.children, 'stbl');
    if (!mdhd || !hdlr || !stbl) return null;

    let v = dv.getUint8(tkhd.dataStart);
    let p = tkhd.dataStart + 4;
    let trackId, creation;
    if (v === 1) { creation = Number(dv.getBigUint64(p)); trackId = dv.getUint32(p + 16); p += 32; }
    else { creation = dv.getUint32(p); trackId = dv.getUint32(p + 8); p += 20; }
    p += 8 + 2 + 2 + 2 + 2; // reserved, layer, alt group, volume, reserved
    const matrix = [];
    for (let i = 0; i < 9; i++) matrix.push(dv.getInt32(p + i * 4) / 65536);
    p += 36;
    const width = dv.getUint32(p) / 65536, height = dv.getUint32(p + 4) / 65536;

    v = dv.getUint8(mdhd.dataStart);
    p = mdhd.dataStart + 4;
    let timescale, mduration;
    if (v === 1) { timescale = dv.getUint32(p + 16); mduration = Number(dv.getBigUint64(p + 20)); }
    else { timescale = dv.getUint32(p + 8); mduration = dv.getUint32(p + 12); }

    const handler = fourcc(dv, hdlr.dataStart + 8);
    const handlerName = latin1(dv, hdlr.dataStart + 24, hdlr.dataEnd).replace(/^[\x00-\x1f]+/, '');

    const stsd = find(stbl.children, 'stsd');
    const codec = stsd && stsd.dataEnd >= stsd.dataStart + 16 ? fourcc(dv, stsd.dataStart + 12) : '';

    const sttsBox = find(stbl.children, 'stts');
    const stts = sttsBox ? parseStts(dv, sttsBox) : [];
    let sampleCount = 0;
    for (const e of stts) sampleCount += e.count;

    // Edit list → presentation offset (seconds) applied to media time
    let editOffset = 0;
    const edts = find(trak.children, 'edts');
    const elst = edts && find(edts.children, 'elst');
    if (elst) {
      const entries = parseElst(dv, elst);
      let empty = 0;
      for (const e of entries) {
        if (e.mediaTime === -1) empty += e.segmentDuration / movieTimescale;
        else { editOffset = empty - e.mediaTime / timescale; break; }
      }
    }

    let rotation = 0;
    // matrix: a b u c d v x y w  — rotation from a/b
    const a = matrix[0], b = matrix[1];
    if (Math.abs(a) < 0.5 && Math.abs(b) > 0.5) rotation = b > 0 ? 90 : 270;
    else if (a < -0.5) rotation = 180;

    const track = {
      id: trackId, handler, handlerName, codec, timescale, duration: mduration / timescale,
      width, height, rotation, creation: creation ? new Date((creation - MAC_EPOCH) * 1000) : null,
      sampleCount, stts, editOffset,
      _stbl: stbl,
    };
    if (stts.length) {
      // dominant frame duration → fps
      let best = stts[0];
      for (const e of stts) if (e.count > best.count) best = e;
      track.fps = best.delta ? timescale / best.delta : 0;
    }
    return track;
  }

  function buildSampleTable(dv, track) {
    const stbl = track._stbl;
    const stsz = parseStsz(dv, find(stbl.children, 'stsz'));
    const stsc = parseStsc(dv, find(stbl.children, 'stsc'));
    const co64 = find(stbl.children, 'co64');
    const stco = co64 ? parseStco(dv, co64, true) : parseStco(dv, find(stbl.children, 'stco'), false);
    const n = stsz.count;
    const samples = new Array(n);
    // durations
    let si = 0, dts = 0;
    for (const e of track.stts) {
      for (let k = 0; k < e.count && si < n; k++) {
        samples[si] = { index: si, time: dts / track.timescale + track.editOffset, duration: e.delta / track.timescale, offset: 0, size: 0 };
        dts += e.delta; si++;
      }
    }
    for (; si < n; si++) samples[si] = { index: si, time: dts / track.timescale + track.editOffset, duration: 0, offset: 0, size: 0 };
    // offsets
    si = 0;
    for (let c = 0; c < stco.length && si < n; c++) {
      let spc = 1;
      for (let i = 0; i < stsc.length; i++) {
        if (stsc[i].firstChunk <= c + 1) spc = stsc[i].samplesPerChunk; else break;
      }
      let off = stco[c];
      for (let k = 0; k < spc && si < n; k++, si++) {
        const size = stsz.uniform || stsz.sizes[si];
        samples[si].offset = off; samples[si].size = size;
        off += size;
      }
    }
    return samples;
  }

  function parseUdta(dv, udtas) {
    const out = {};
    for (const udta of udtas) for (const b of udta.children || []) {
      const len = b.dataEnd - b.dataStart;
      if (b.type === 'GPMF') { out.GPMF = dv.buffer.slice(dv.byteOffset + b.dataStart, dv.byteOffset + b.dataEnd); continue; }
      if (len > 0 && len < 512) {
        let printable = true, s = '';
        for (let i = b.dataStart; i < b.dataEnd; i++) {
          const c = dv.getUint8(i);
          if (c === 0) continue;
          if (c < 0x20 || c > 0x7e) { printable = false; break; }
          s += String.fromCharCode(c);
        }
        if (printable && s.length) out[b.type] = s;
      }
    }
    return out;
  }

  async function open(file, onProgress) {
    const top = await readTopLevel(file);
    const moovBox = top.find(b => b.type === 'moov');
    if (!moovBox) throw new Error('No moov box found — is this an MP4/MOV file?');
    if (onProgress) onProgress('Reading movie header (' + (moovBox.size / 1e6).toFixed(1) + ' MB)…');
    const dv = new DataView(await file.slice(moovBox.offset, moovBox.offset + moovBox.size).arrayBuffer());
    const moov = parseBoxes(dv, 0, dv.byteLength)[0];
    if (!moov || moov.type !== 'moov') throw new Error('Could not parse moov box');

    const mvhd = find(moov.children, 'mvhd');
    let movieTimescale = 1000, movieDuration = 0, creation = null;
    if (mvhd) {
      const v = dv.getUint8(mvhd.dataStart);
      const p = mvhd.dataStart + 4;
      if (v === 1) { creation = Number(dv.getBigUint64(p)); movieTimescale = dv.getUint32(p + 16); movieDuration = Number(dv.getBigUint64(p + 20)); }
      else { creation = dv.getUint32(p); movieTimescale = dv.getUint32(p + 8); movieDuration = dv.getUint32(p + 12); }
    }

    const tracks = [];
    for (const trak of findAll(moov.children, 'trak')) {
      const t = parseTrack(dv, trak, movieTimescale);
      if (t) tracks.push(t);
    }
    const video = tracks.find(t => t.handler === 'vide');
    const audio = tracks.find(t => t.handler === 'soun');
    const gpmd = tracks.find(t => t.codec === 'gpmd') || tracks.find(t => t.handler === 'meta' && /GoPro MET/i.test(t.handlerName));
    const info = {
      fileName: file.name, fileSize: file.size,
      duration: movieDuration / movieTimescale,
      creation: creation ? new Date((creation - MAC_EPOCH) * 1000) : null,
      brand: '', tracks: tracks.map(t => ({ id: t.id, handler: t.handler, handlerName: t.handlerName, codec: t.codec, duration: t.duration, sampleCount: t.sampleCount, fps: t.fps, width: t.width, height: t.height })),
      video: video ? { fps: video.fps, width: video.width, height: video.height, codec: video.codec, frames: video.sampleCount, duration: video.duration, rotation: video.rotation } : null,
      audio: audio ? { codec: audio.codec, duration: audio.duration } : null,
      udta: parseUdta(dv, findAll(moov.children, 'udta')),
    };
    const ftyp = top.find(b => b.type === 'ftyp');
    if (ftyp) {
      const f = new DataView(await file.slice(ftyp.offset + 8, ftyp.offset + 12).arrayBuffer());
      info.brand = fourcc(f, 0);
    }
    let payloads = [];
    if (gpmd) {
      if (onProgress) onProgress('Reading telemetry samples…');
      const samples = buildSampleTable(dv, gpmd);
      payloads = await readSamples(file, samples, onProgress);
      info.gpmd = { sampleCount: samples.length, duration: gpmd.duration, bytes: samples.reduce((a, s) => a + s.size, 0) };
    }
    return { info, payloads };
  }

  async function readSamples(file, samples, onProgress) {
    const groups = [];
    for (const s of samples) {
      if (s.size === 0) continue;
      const g = groups[groups.length - 1];
      if (g && g.offset + g.size === s.offset && g.size < 8e6) { g.size += s.size; g.items.push(s); }
      else groups.push({ offset: s.offset, size: s.size, items: [s] });
    }
    const payloads = [];
    let done = 0;
    for (const g of groups) {
      if (g.offset + g.size > file.size) break;
      const buf = await file.slice(g.offset, g.offset + g.size).arrayBuffer();
      let o = 0;
      for (const s of g.items) {
        payloads.push({ buffer: buf, byteOffset: o, byteLength: s.size, time: s.time, duration: s.duration, index: s.index });
        o += s.size;
      }
      done++;
      if (onProgress && (done % 50 === 0)) onProgress('Reading telemetry… ' + Math.round(100 * done / groups.length) + '%');
    }
    return payloads;
  }

  return { open, readTopLevel, parseBoxes, buildSampleTable, fourcc };
})();
if (typeof module !== 'undefined') module.exports = MP4;
