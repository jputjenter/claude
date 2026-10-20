#!/usr/bin/env node
/* Builds fixtures/demo.mp4: an ffmpeg test clip with a synthetic GoPro-style
 * "gpmd" telemetry track injected (ACCL, GYRO, GPS5, CORI, SHUT, ISOE).
 * Usage: node tools/make-fixture.js [out.mp4] [--seconds N] [--codec libvpx-vp9|libx264]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'fixtures', 'demo.mp4');
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseInt(opt('seconds', '12'), 10);
const CODEC = opt('codec', 'libvpx-vp9');
const FPS = 60;

// ---------- ISO BMFF writers
const u8 = n => { const b = Buffer.alloc(1); b.writeUInt8(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const f32 = n => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; };
const str = s => Buffer.from(s, 'latin1');
const box = (type, ...p) => { const body = Buffer.concat(p); return Buffer.concat([u32(8 + body.length), str(type), body]); };
const fullbox = (type, v, flags, ...p) => box(type, u8(v), Buffer.from([(flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...p);

// ---------- GPMF writers
function klv(key, type, size, repeat, data) {
  const pad = (4 - (data.length % 4)) % 4;
  return Buffer.concat([str(key), u8(type ? type.charCodeAt(0) : 0), u8(size), u16(repeat), data, Buffer.alloc(pad)]);
}
const nested = (key, children) => { const body = Buffer.concat(children); if (body.length > 65535) throw new Error('nested too big'); return klv(key, null, 1, body.length, body); };
const kstr = (key, s) => klv(key, 'c', s.length, 1, str(s));
const kstrs = (key, list) => { const w = Math.max(...list.map(s => s.length)); return klv(key, 'c', w, list.length, Buffer.concat(list.map(s => Buffer.concat([str(s), Buffer.alloc(w - s.length)])))); };
const kL = (key, ...v) => klv(key, 'L', 4, v.length, Buffer.concat(v.map(u32)));
const kl = (key, ...v) => klv(key, 'l', 4, v.length, Buffer.concat(v.map(i32)));
const ks = (key, ...v) => klv(key, 's', 2, v.length, Buffer.concat(v.map(i16)));
const kS = (key, ...v) => klv(key, 'S', 2, v.length, Buffer.concat(v.map(u16)));
const kf = (key, ...v) => klv(key, 'f', 4, v.length, Buffer.concat(v.map(f32)));
const samples = (key, type, comps, rows, enc) => klv(key, type, comps * (type === 's' ? 2 : 4), rows.length, Buffer.concat(rows.map(r => Buffer.concat(r.map(enc)))));

function gpmfPayload(sec) {
  const strm = [];
  // ACCL 200 Hz, int16 / 418 = m/s²
  const accl = [];
  for (let i = 0; i < 200; i++) {
    const t = sec + i / 200;
    const z = 9.81 + 2.5 * Math.sin(2 * Math.PI * 0.7 * t) + (sec === 6 && i > 90 && i < 110 ? 25 : 0); // an impact spike at ~6.5 s
    const x = 1.2 * Math.sin(2 * Math.PI * 1.3 * t), y = 0.8 * Math.cos(2 * Math.PI * 0.4 * t);
    accl.push([z, x, y].map(v => Math.round(v * 418)));
  }
  strm.push(nested('STRM', [kL('TSMP', (sec + 1) * 200), kstr('STNM', 'Accelerometer'), kstr('ORIN', 'ZXY'), kstr('ORIO', 'XYZ'), kstr('SIUN', 'm/s\xb2'), ks('SCAL', 418), kf('TMPC', 31.5), samples('ACCL', 's', 3, accl, i16)]));
  // GYRO 200 Hz, int16 / 939 = rad/s
  const gyro = [];
  for (let i = 0; i < 200; i++) { const t = sec + i / 200; gyro.push([0.3 * Math.sin(2 * Math.PI * 0.5 * t), 1.5 * Math.sin(2 * Math.PI * 1.1 * t + 1), 0.1 * Math.cos(2 * Math.PI * 2 * t)].map(v => Math.round(v * 939))); }
  strm.push(nested('STRM', [kL('TSMP', (sec + 1) * 200), kstr('STNM', 'Gyroscope'), kstr('ORIN', 'ZXY'), kstr('ORIO', 'XYZ'), kstr('SIUN', 'rad/s'), ks('SCAL', 939), samples('GYRO', 's', 3, gyro, i16)]));
  // GPS5 18 Hz — circle of 80 m radius around a point, speed ramps up
  const gps = [];
  for (let i = 0; i < 18; i++) {
    const t = sec + i / 18, R = 80, w = 2 * Math.PI / 20;
    const lat = 46.52065 + (R * Math.sin(w * t)) / 110540, lon = 6.63210 + (R * Math.cos(w * t)) / (111320 * Math.cos(46.52 * Math.PI / 180));
    const alt = 372 + 3 * Math.sin(2 * Math.PI * t / 12), v2 = R * w * (0.5 + 0.5 * Math.min(1, t / 6)), v3 = v2 * 1.02;
    gps.push([Math.round(lat * 1e7), Math.round(lon * 1e7), Math.round(alt * 1000), Math.round(v2 * 1000), Math.round(v3 * 100)]);
  }
  const ts = new Date(Date.UTC(2026, 0, 1, 12, 0, sec)).toISOString().replace(/[-:TZ.]/g, '').slice(2, 17); // yymmddhhmmssSSS
  strm.push(nested('STRM', [kL('TSMP', (sec + 1) * 18), kstr('STNM', 'GPS (Lat., Long., Alt., 2D speed, 3D speed)'), klv('GPSU', 'U', 16, 1, str(ts.slice(0, 12) + '.' + ts.slice(12).padEnd(3, '0'))), kL('GPSF', 3), kS('GPSP', 500),
    kstrs('UNIT', ['deg', 'deg', 'm', 'm/s', 'm/s']), kl('SCAL', 10000000, 10000000, 1000, 1000, 100), samples('GPS5', 'l', 5, gps, i32)]));
  // CORI 30 Hz quaternion int16 / 32767
  const cori = [];
  for (let i = 0; i < 30; i++) { const t = sec + i / 30, a = 0.3 * Math.sin(2 * Math.PI * 0.2 * t); cori.push([Math.cos(a / 2), 0, Math.sin(a / 2), 0].map(v => Math.round(v * 32767))); }
  strm.push(nested('STRM', [kL('TSMP', (sec + 1) * 30), kstr('STNM', 'CameraOrientation'), ks('SCAL', 32767), samples('CORI', 's', 4, cori, i16)]));
  // SHUT (s) and ISOE 60 Hz float
  const shut = [], iso = [];
  for (let i = 0; i < 60; i++) { const t = sec + i / 60; shut.push([1 / (480 + 200 * Math.sin(2 * Math.PI * t / 12))]); iso.push([Math.round(100 + 300 * (0.5 + 0.5 * Math.sin(2 * Math.PI * t / 12)))]); }
  strm.push(nested('STRM', [kL('TSMP', (sec + 1) * 60), kstr('STNM', 'Exposure time (shutter speed)'), kstr('SIUN', 's'), samples('SHUT', 'f', 1, shut, f32)]));
  strm.push(nested('STRM', [kL('TSMP', (sec + 1) * 60), kstr('STNM', 'Sensor ISO'), samples('ISOE', 'f', 1, iso, f32)]));
  return nested('DEVC', [kL('DVID', 1), kstr('DVNM', 'HeroScope synthetic camera'), ...strm]);
}

// ---------- parse top-level boxes of the base file
function topLevel(buf) {
  const boxes = []; let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8); let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; } else if (size === 0) size = buf.length - off;
    boxes.push({ type, off, size, hdr }); off += size;
  }
  return boxes;
}
function children(buf, start, end) {
  const out = []; let off = start;
  while (off + 8 <= end) { let size = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8); let hdr = 8; if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; } if (size < hdr) break; out.push({ type, off, size, hdr }); off += size; }
  return out;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heroscope-'));
  const base = path.join(tmp, 'base.mp4');
  const vargs = CODEC === 'libx264' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p'] : ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'];
  const aargs = CODEC === 'libx264' ? ['-c:a', 'aac', '-b:a', '64k'] : ['-c:a', 'libopus', '-b:a', '48k'];
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', String(SECONDS), ...vargs, ...aargs, '-shortest', base], { stdio: 'inherit' });
  const buf = fs.readFileSync(base);
  const top = topLevel(buf);
  const moov = top[top.length - 1];
  if (moov.type !== 'moov') throw new Error('expected moov to be the last top-level box (no faststart)');
  const moovKids = children(buf, moov.off + moov.hdr, moov.off + moov.size);
  const mvhd = moovKids.find(b => b.type === 'mvhd');
  const movieTimescale = buf.readUInt32BE(mvhd.off + 8 + 4 + 8);
  const trakCount = moovKids.filter(b => b.type === 'trak').length;

  const payloads = [];
  for (let s = 0; s < SECONDS; s++) payloads.push(gpmfPayload(s));
  const mdatBody = Buffer.concat(payloads);
  const preMoov = buf.subarray(0, moov.off);

  // Build the new trak; stco needs absolute offsets which depend on the final moov size → iterate twice.
  const buildTrak = (mdatStart) => {
    const offs = []; let o = mdatStart + 8;
    for (const p of payloads) { offs.push(o); o += p.length; }
    const tkhd = fullbox('tkhd', 0, 7, u32(0), u32(0), u32(trakCount + 1), u32(0), u32(Math.round(SECONDS * movieTimescale)), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0),
      Buffer.concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]), u32(0), u32(0));
    const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(1000), u32(SECONDS * 1000), u16(0x55c4), u16(0));
    const hdlr = fullbox('hdlr', 0, 0, u32(0), str('meta'), Buffer.alloc(12), str('GoPro MET\0'));
    const gmhd = box('gmhd', fullbox('gmin', 0, 0, u16(0), u16(0x8000), u16(0x8000), u16(0x8000), u16(0), u16(0)));
    const dinf = box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
    const stsd = fullbox('stsd', 0, 0, u32(1), box('gpmd', Buffer.alloc(6), u16(1)));
    const stts = fullbox('stts', 0, 0, u32(1), u32(payloads.length), u32(1000));
    const stsc = fullbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
    const stsz = fullbox('stsz', 0, 0, u32(0), u32(payloads.length), ...payloads.map(p => u32(p.length)));
    const stco = fullbox('stco', 0, 0, u32(offs.length), ...offs.map(u32));
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    const minf = box('minf', gmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return box('trak', tkhd, mdia);
  };
  const udta = box('udta', box('FIRM', str('HS01.00.00.00')), box('LENS', str('synthetic')), box('CAME', Buffer.from('HEROSCOPE000001', 'latin1')));
  const origMoovBody = buf.subarray(moov.off + moov.hdr, moov.off + moov.size);
  let trak = buildTrak(0);
  let newMoovSize = 8 + origMoovBody.length + trak.length + udta.length;
  trak = buildTrak(moov.off + newMoovSize);
  const newMoov = box('moov', origMoovBody, trak, udta);
  if (newMoov.length !== newMoovSize) throw new Error('moov size mismatch');
  const mdat = box('mdat', mdatBody);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([preMoov, newMoov, mdat]));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${out}: ${SECONDS}s @ ${FPS}fps ${CODEC}, ${payloads.length} GPMF payloads (${mdatBody.length} bytes), total ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
}
main();
