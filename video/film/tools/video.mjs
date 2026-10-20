// 逐帧渲染整片画面到 out/video.mp4（无声）
// 用法: node video/film/tools/video.mjs [--fps 24] [--workers 3] [--from 0] [--to DUR] [--out 路径]
// 依赖 playwright 与 ffmpeg；未在本项目安装 playwright 时用 PLAYWRIGHT_PATH 指向全局安装的 index.mjs
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pageUrl = pathToFileURL(path.join(root, 'index.html')).href;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const fps = Number(opt('fps', 24));
const workers = Number(opt('workers', 3));
const out = path.resolve(opt('out', path.join(root, 'out', 'video.mp4')));
const frameDir = path.join(path.dirname(out), 'frames');
fs.rmSync(frameDir, { recursive: true, force: true });
fs.mkdirSync(frameDir, { recursive: true });

const browser = await chromium.launch();
const probe = await browser.newPage();
await probe.goto(pageUrl);
await probe.waitForFunction(() => window.READY === true);
const dur = await probe.evaluate(() => window.DUR);
await probe.close();
const from = Number(opt('from', 0)), to = Number(opt('to', dur));
const total = Math.round((to - from) * fps);

// 每个 worker 一个页面，按帧号交错分配；帧由 canvas 直接导出 JPEG
let doneCount = 0;
async function work(w) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pageUrl);
  await page.waitForFunction(() => window.READY === true);
  for (let i = w; i < total; i += workers) {
    const t = from + i / fps;
    const data = await page.evaluate((t) => { window.render(t); return document.getElementById('c').toDataURL('image/jpeg', 0.92); }, t);
    fs.writeFileSync(path.join(frameDir, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
    if (++doneCount % (fps * 5) === 0) console.log(`${doneCount}/${total}`);
  }
  await page.close();
}
await Promise.all(Array.from({ length: workers }, (_, w) => work(w)));
await browser.close();

const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(frameDir, '%05d.jpg'),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
fs.rmSync(frameDir, { recursive: true, force: true });
console.log(out);
