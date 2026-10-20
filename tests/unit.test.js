'use strict';
/* Unit tests for the MP4 + GPMF parsers, run with: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MP4 = require('../js/mp4.js');
const GPMF = require('../js/gpmf.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'demo.mp4');
const fileBlob = () => { const b = fs.readFileSync(FIX); const blob = new Blob([b], { type: 'video/mp4' }); blob.name = 'demo.mp4'; return blob; };

test('MP4.open finds video track, fps and gpmd payloads', async () => {
  const { info, payloads } = await MP4.open(fileBlob());
  assert.equal(info.brand, 'isom');
  assert.ok(info.video, 'video track');
  assert.equal(info.video.width, 640);
  assert.equal(info.video.height, 360);
  assert.ok(Math.abs(info.video.fps - 60) < 0.01, 'fps ' + info.video.fps);
  assert.ok(Math.abs(info.duration - 12) < 0.1, 'duration ' + info.duration);
  assert.equal(payloads.length, 12);
  assert.equal(payloads[0].time, 0);
  assert.ok(Math.abs(payloads[5].time - 5) < 1e-9);
  assert.equal(payloads[0].duration, 1);
  assert.equal(info.udta.FIRM, 'HS01.00.00.00');
  assert.ok(info.tracks.some(t => t.codec === 'gpmd'));
});

test('GPMF.parse reads KLV tree of a payload', async () => {
  const { payloads } = await MP4.open(fileBlob());
  const p = payloads[0];
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const roots = GPMF.parse(dv, 0, dv.byteLength);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].key, 'DEVC');
  const keys = roots[0].children.map(n => n.key);
  assert.deepEqual(keys.slice(0, 2), ['DVID', 'DVNM']);
  assert.equal(keys.filter(k => k === 'STRM').length, 6);
  const dvnm = roots[0].children[1];
  assert.equal(GPMF.values(dvnm)[0], 'HeroScope synthetic camera');
});

test('GPMF.extract builds scaled streams with timestamps', async () => {
  const { payloads } = await MP4.open(fileBlob());
  const { streams, devices } = GPMF.extract(payloads);
  assert.deepEqual(Object.keys(streams).sort(), ['ACCL', 'CORI', 'GPS5', 'GYRO', 'ISOE', 'SHUT']);
  assert.equal(devices[1], 'HeroScope synthetic camera');
  const a = streams.ACCL;
  assert.equal(a.count, 2400);
  assert.equal(a.comps, 4, 'x,y,z + magnitude');
  assert.deepEqual(a.labels, ['Z', 'X', 'Y', '|magnitude|']);
  assert.equal(a.units[0], 'm/s\xb2');
  assert.ok(Math.abs(a.rate - 200) < 1, 'rate ' + a.rate);
  // first sample ≈ 9.81 + 0 (t=0): z = 9.81
  assert.ok(Math.abs(a.cols[0][0] - 9.81) < 0.01, 'scaled z ' + a.cols[0][0]);
  assert.ok(Math.abs(a.times[200] - 1) < 1e-9, 'second payload starts at 1 s');
  assert.ok(Math.abs(a.times[2399] - (11 + 199 / 200)) < 1e-9);
  // magnitude ≥ |z|
  assert.ok(a.cols[3][0] >= Math.abs(a.cols[0][0]));
  // impact spike visible at ~6.5 s
  const i = Math.round(6.5 * 200);
  assert.ok(a.cols[0][i] > 30, 'spike ' + a.cols[0][i]);
  const g = streams.GPS5;
  assert.equal(g.comps, 5);
  assert.deepEqual(g.units, ['deg', 'deg', 'm', 'm/s', 'm/s']);
  assert.ok(Math.abs(g.cols[0][0] - 46.52065) < 1e-6, 'lat scale');
  assert.ok(Math.abs(g.cols[2][0] - 372) < 0.01, 'alt scale');
  assert.equal(g.attrs.GPSF[0].v, 3);
  assert.equal(g.attrs.GPSP[0].v, 500);
  assert.match(g.attrs.GPSU[0].v, /^260101120000\.000$/);
  assert.equal(g.attrs.GPSU.length, 12);
  const c = streams.CORI;
  assert.deepEqual(c.labels, ['w', 'x', 'y', 'z']);
  assert.ok(Math.abs(c.cols[0][0] - 1) < 1e-3, 'quaternion w scaled by 32767');
  assert.equal(streams.SHUT.units[0], 's');
  assert.equal(streams.ISOE.count, 720);
});

test('GPMF.values decodes complex TYPE structures', () => {
  // build a node: TYPE "Lf" , 2 samples
  const buf = new ArrayBuffer(8 + 16);
  const dv = new DataView(buf);
  const w = s => { for (let i = 0; i < 4; i++) dv.setUint8(i, s.charCodeAt(i)); };
  w('FACE'); dv.setUint8(4, '?'.charCodeAt(0)); dv.setUint8(5, 8); dv.setUint16(6, 2);
  dv.setUint32(8, 7); dv.setFloat32(12, 1.5); dv.setUint32(16, 9); dv.setFloat32(20, -2);
  const node = GPMF.parse(dv, 0, 24)[0];
  assert.equal(node.key, 'FACE');
  assert.deepEqual(GPMF.values(node, 'Lf'), [[7, 1.5], [9, -2]]);
  assert.deepEqual(GPMF.expandType('c[3]L'), ['c', 'c', 'c', 'L']);
});

test('GPMF.flatten summarises a udta GPMF blob', () => {
  const parts = [];
  const push = (key, type, size, repeat, data) => { const h = Buffer.alloc(8); h.write(key, 0, 'latin1'); h[4] = type.charCodeAt(0); h[5] = size; h.writeUInt16BE(repeat, 6); parts.push(h, data, Buffer.alloc((4 - data.length % 4) % 4)); };
  push('FIRM', 'c', 5, 1, Buffer.from('H22.1', 'latin1'));
  const l = Buffer.alloc(4); l.writeUInt32BE(42); push('VERS', 'L', 4, 1, l);
  const b = Buffer.concat(parts);
  const flat = GPMF.flatten(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.deepEqual(flat.map(x => [x.key, x.value]), [['FIRM', 'H22.1'], ['VERS', '42']]);
});
