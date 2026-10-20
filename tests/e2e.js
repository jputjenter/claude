#!/usr/bin/env node
/* End-to-end smoke test with Playwright (Chromium). Serves the repo over http,
 * loads fixtures/demo.mp4, exercises transport, trim, dashboard and exports.
 * Usage: node tests/e2e.js [--headed] [--shots DIR] */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  const candidates = [process.cwd(), '/opt/node-tools', '/opt/node-tools/node_modules'];
  try { candidates.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch (e) { /* ignore */ }
  for (const base of candidates) { try { return require(require.resolve('playwright', { paths: [base] })); } catch (e) { /* next */ } }
  throw new Error('playwright not found; npm i -D playwright');
}
const { chromium } = loadPlaywright();
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.json': 'application/json', '.svg': 'image/svg+xml' };
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.normalize(decodeURIComponent(req.url.split('?')[0]));
      let file = path.join(ROOT, p === path.sep ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
      const stat = fs.statSync(file);
      const range = req.headers.range;
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range); const start = m[1] ? parseInt(m[1], 10) : 0; const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const pngSize = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: !args.includes('--headed') });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  let passed = 0;
  const check = (name, ok, detail) => { if (!ok) throw new Error(`FAIL ${name}${detail ? ': ' + detail : ''}`); passed++; console.log('  ok', name); };
  const download = async (fn) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), fn()]); const p = path.join(SHOTS || require('os').tmpdir(), d.suggestedFilename()); await d.saveAs(p); return { name: d.suggestedFilename(), path: p, size: fs.statSync(p).size }; };
  try {
    await page.goto(url);
    check('page title', (await page.title()).includes('HeroScope'));
    await page.setInputFiles('#fileInput', path.join(ROOT, 'fixtures', 'demo.mp4'));
    await page.waitForFunction(() => /6 telemetry streams/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
    const statusText = await page.textContent('#status');
    check('status lists streams', /ACCL.*GYRO/.test(statusText), statusText);
    await page.waitForFunction(() => { const v = document.getElementById('video'); return v.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 20000 });
    const vinfo = await page.evaluate(() => { const v = document.getElementById('video'); return { d: v.duration, w: v.videoWidth, h: v.videoHeight, fps: HeroScope.state.fps, frames: HeroScope.state.frames }; });
    check('video decodes (640x360, 12 s, 60 fps)', Math.abs(vinfo.d - 12) < 0.1 && vinfo.w === 640 && Math.abs(vinfo.fps - 60) < 0.01 && vinfo.frames === 720, JSON.stringify(vinfo));
    const panels = await page.$$eval('.panel', ps => ps.map(p => p.dataset.type));
    check('default dashboard built', panels.includes('chart') && panels.includes('values') && panels.includes('track') && panels.includes('info'), panels.join(','));
    check('charts rendered on canvas', (await page.$$('.panel .tc-base')).length >= 3);
    // frame stepping
    await page.click('#tFwd1'); await page.waitForTimeout(150);
    await page.click('#tFwd10'); await page.waitForTimeout(150);
    let tc = await page.textContent('#tcFrame');
    check('frame stepping (+1, +10 → F 11)', /^F 11 \//.test(tc), tc);
    await page.click('#tBack1'); await page.waitForTimeout(150);
    check('frame step back', /^F 10 \//.test(await page.textContent('#tcFrame')));
    check('timecode format', /^00:00:00:10$/.test(await page.textContent('#tcMain')), await page.textContent('#tcMain'));
    // seek to spike and read live value
    await page.evaluate(() => HeroScope.seek(6.5)); await page.waitForTimeout(250);
    const liveVals = await page.$$eval('.vtile .v', es => es.map(e => e.textContent));
    check('live values at playhead', liveVals.length >= 2 && liveVals.every(v => v !== '—' && /\d/.test(v)), liveVals.join('|'));
    const accMag = parseFloat(liveVals[0]);
    check('accelerometer spike visible at 6.5 s', accMag > 30, String(accMag));
    // cursor line toggle
    await page.keyboard.press('c');
    check('cursor toggle off', !(await page.evaluate(() => HeroScope.state.cursorOn)));
    await page.keyboard.press('c');
    check('cursor toggle on', await page.evaluate(() => HeroScope.state.cursorOn));
    // trim
    await page.evaluate(() => HeroScope.seek(2.0)); await page.waitForTimeout(100);
    await page.keyboard.press('i');
    await page.evaluate(() => HeroScope.seek(5.0)); await page.waitForTimeout(100);
    await page.keyboard.press('o');
    const trimInfo = await page.textContent('#trimInfo');
    check('trim in/out set (frames 120–300 inclusive = 181 f)', /\(181 f, 3\.017 s\)/.test(trimInfo), trimInfo);
    await page.keyboard.press('Home'); await page.waitForTimeout(200);
    check('Home jumps to in point', /^F 120 \//.test(await page.textContent('#tcFrame')), await page.textContent('#tcFrame'));
    // playback inside trim loops
    await page.keyboard.press(' '); await page.waitForTimeout(1200);
    const playing = await page.evaluate(() => !document.getElementById('video').paused);
    const tPlay = await page.evaluate(() => document.getElementById('video').currentTime);
    check('playback runs inside trim', playing && tPlay > 2.0 && tPlay < 5.05, String(tPlay));
    await page.keyboard.press('k');
    check('K pauses', await page.evaluate(() => document.getElementById('video').paused));
    // speed
    await page.keyboard.press('ArrowUp');
    check('speed up to 2x', Math.abs(await page.evaluate(() => HeroScope.state.speed) - 2) < 1e-9);
    await page.keyboard.press('ArrowDown');
    // markers
    await page.keyboard.press('m');
    check('marker added', /M1@/.test(await page.textContent('#markInfo')));
    // chart interaction: wheel zoom + click seeks
    const over = (await page.$$('.panel[data-type=chart] .tc-over'))[0];
    const box = await over.boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.mouse.wheel(0, -600); await page.waitForTimeout(100);
    const view = await page.evaluate(() => HeroScope.state.view);
    check('wheel zooms linked time axis', view.t1 - view.t0 < 11, JSON.stringify(view));
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2); await page.waitForTimeout(50);
    check('hover tooltip shows every series', (await page.$$eval('.tc-tip', ts => ts.filter(t => !t.hidden).map(t => t.querySelectorAll('.tc-tip-row').length))).some(n => n >= 3));
    await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(200);
    const tAfterClick = await page.evaluate(() => document.getElementById('video').currentTime);
    check('click on chart seeks video', tAfterClick > view.t0 && tAfterClick < view.t1, String(tAfterClick));
    await over.dblclick(); await page.waitForTimeout(50);
    // exports
    const frame = await download(() => page.click('#btnFrame'));
    const fpng = fs.readFileSync(frame.path);
    check('full-res frame PNG (640x360)', frame.name.endsWith('.png') && pngSize(fpng).w === 640 && pngSize(fpng).h === 360, frame.name + ' ' + JSON.stringify(pngSize(fpng)));
    const shot = await download(() => page.click('#btnScreenshot'));
    const spng = fs.readFileSync(shot.path);
    check('interface screenshot PNG', shot.name.includes('heroscope') && pngSize(spng).w >= 1500 && shot.size > 20000, shot.name + ' ' + shot.size);
    const trimJson = await download(async () => { await page.click('#btnExportTrim'); await page.click('#dlgButtons button.primary'); });
    const tj = JSON.parse(fs.readFileSync(trimJson.path, 'utf8'));
    check('trim JSON export', tj.in_frame === 120 && tj.out_frame === 301 && tj.frames === 181 && tj.markers.length === 1, JSON.stringify(tj));
    const csv = await download(async () => { await page.click('#btnExportCsv'); await page.selectOption('#dlgBody select', 'ACCL'); await page.click('#dlgButtons button.primary'); });
    const lines = fs.readFileSync(csv.path, 'utf8').trim().split('\n');
    check('CSV export honours trim (≈3 s × 200 Hz)', lines.length === 605 && /^time_s,frame,ACCL_Z/.test(lines[0]), lines.length + ' ' + lines[0]);
    // presets & custom panel
    await page.selectOption('#presetSelect', 'all');
    check('"every stream" preset → 6 charts', (await page.$$('.panel[data-type=chart]')).length === 6);
    await page.selectOption('#presetSelect', 'blank');
    await page.click('#btnAddPanel'); await page.fill('#dlgBody input[type=text]', 'Overlay'); await page.click('#dlgButtons button.primary');
    await page.selectOption('.panel-foot select', 'GYRO|*');
    await page.selectOption('.panel-foot select', 'GPS5|3');
    const chipsN = (await page.$$('.panel .chip')).length;
    const ymode = await page.$eval('.panel-foot select.ymode', s => s.value);
    check('overlay 4 series, mixed units → normalized', chipsN === 4 && ymode === 'norm', chipsN + ' ' + ymode);
    const layout = await download(() => page.click('#btnExportLayout'));
    const lj = JSON.parse(fs.readFileSync(layout.path, 'utf8'));
    check('layout export', lj.panels.length === 1 && lj.panels[0].series.length === 4);
    // layout persists across reload
    await page.reload();
    await page.waitForSelector('.panel');
    check('layout restored from localStorage', (await page.$$('.panel .chip')).length === 4);
    // theme toggle
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.click('#btnTheme');
    const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
    check('theme toggles', themeBefore !== themeAfter && ['light', 'dark'].includes(themeAfter), themeBefore + '→' + themeAfter);
    await page.click('#btnTheme');
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setInputFiles('#fileInput', path.join(ROOT, 'fixtures', 'demo.mp4'));
      await page.waitForFunction(() => /6 telemetry streams/.test(document.getElementById('status').textContent));
      await page.selectOption('#presetSelect', 'default');
      await page.evaluate(() => { if (document.documentElement.dataset.theme !== 'dark') document.getElementById('btnTheme').click(); });
      await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
      await page.evaluate(() => HeroScope.seek(6.5)); await page.keyboard.press('m'); await page.evaluate(() => HeroScope.seek(3.2)); await page.keyboard.press('i'); await page.evaluate(() => HeroScope.seek(9.0)); await page.keyboard.press('o'); await page.evaluate(() => HeroScope.seek(6.4));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, 'ui-dark.png') });
      await page.click('#btnTheme'); await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, 'ui-light.png') });
      console.log('  screenshots in', SHOTS);
    }
    check('no page errors', errors.length === 0, errors.join('\n'));
    console.log(`\nE2E passed (${passed} checks)`);
  } catch (e) {
    console.error('\n' + e.message);
    if (errors.length) console.error('page errors:\n' + errors.join('\n'));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {}); }
    process.exitCode = 1;
  } finally {
    await browser.close(); srv.close();
  }
})();
