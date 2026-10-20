#!/usr/bin/env node

// 必须放最前：Node 版本守卫，先于任何会用到全局 fetch 的模块求值
import './lib/preflight.js';

// CLI 入口依赖动态加载，确保低版本 Node 先执行 preflight 并给出可读提示
Promise.all([import('./lib/command.js'), import('./utils/logger.js'), import('chalk')])
  .then(async ([{ createProgram }, { logger }, { default: chalk }]) => {
    // 遵循 NO_COLOR 约定（no-color.org）：关闭颜色，像素图同时退回文字
    if (process.env.NO_COLOR) chalk.level = 0;
    const program = createProgram();
    try {
      await program.parseAsync(process.argv);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
