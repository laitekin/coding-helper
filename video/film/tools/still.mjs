// 渲染指定时间点的静帧（风格帧 / 审片用）
// 用法: node video/film/tools/still.mjs <输出目录> <名字=秒> [...]，名字以 sheet 结尾时输出角色设定稿
// 依赖 playwright；未在本项目安装时用 PLAYWRIGHT_PATH 指向全局安装的 index.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = pathToFileURL(path.join(here, '..', 'index.html')).href;
const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || !specs.length) {
  console.error('用法: node still.mjs <输出目录> <名字=秒> [...]');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const spec of specs) {
  const [name, sec] = spec.split('=');
  const q = name.endsWith('sheet') ? '?sheet=1' : `?t=${Number(sec)}`;
  await page.goto(page_url + q);
  await page.waitForFunction(() => window.READY === true);
  await page.evaluate((t) => window.render(t), Number(sec) || 0);
  const file = path.join(outDir, `${name}.png`);
  await page.locator('canvas').screenshot({ path: file });
  console.log(file);
}
await browser.close();
