// 构建后把翻译文件复制到 dist/locales（tsc 不复制 JSON）；用 Node 实现，Windows 上也能运行
import fs from 'node:fs';

fs.rmSync('dist/locales', { recursive: true, force: true });
fs.cpSync('src/locales', 'dist/locales', { recursive: true });
