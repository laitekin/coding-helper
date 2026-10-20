import chalk from 'chalk';
import { logger } from '../../../utils/logger.js';
import { GRADIENT } from './theme.js';
import { VERSION } from '../../version.js';
import { t } from '../../i18n.js';
import { logoGrid, renderGrid, renderSprite, joinBlocks, pixelsSupported, LOGO_WIDTH, SPRITE_WIDTH } from './pixel.js';

// "QINIU" ASCII Art（不支持 256 色或终端过窄时使用，约 34 列宽）
const LOGO_LINES = [
  '  ██████  ██ ███    ██ ██ ██    ██',
  ' ██    ██ ██ ████   ██ ██ ██    ██',
  ' ██    ██ ██ ██ ██  ██ ██ ██    ██',
  ' ██ ▄▄ ██ ██ ██  ██ ██ ██ ██    ██',
  '  ██████  ██ ██   ████ ██  ██████ ',
  '     ▀▀                           ',
];

// Logo 与小牛之间留 5 列
const LOGO_GAP = 5;
// 像素 Logo + 小牛需要的最小终端宽度
const PIXEL_MIN_COLUMNS = 2 + LOGO_WIDTH + LOGO_GAP + SPRITE_WIDTH + 4;

function renderTagline(): void {
  logger.log(
    `  ${chalk.bold.hex('#E8F6FF')('Coding Helper')}  ${chalk.hex('#7D8B99')(`v${VERSION}`)}  ` +
    `${chalk.hex('#7D8B99')('·')}  ${chalk.hex('#9FB0BF')(t('header_tagline'))}`,
  );
}

// 渲染七牛 Logo：宽终端用像素字 + 小牛 + 已接入工具的角色（放不下的省略），否则用文字 Logo
export function renderLogo(connected: string[] = []): void {
  logger.newLine();
  const columns = process.stdout.columns || 0;
  if (pixelsSupported() && columns >= PIXEL_MIN_COLUMNS) {
    const room = Math.max(0, Math.floor((columns - PIXEL_MIN_COLUMNS) / (SPRITE_WIDTH + 1)));
    const sprites = ['qiniu', ...connected.slice(0, room)];
    const blocks = [renderGrid(logoGrid()), ...sprites.map((id) => renderSprite(id))];
    const widths = [LOGO_WIDTH + LOGO_GAP - 1, ...sprites.map(() => SPRITE_WIDTH)];
    for (const line of joinBlocks(blocks, widths, 1)) logger.log(`  ${line}`);
    logger.newLine();
    renderTagline();
    logger.newLine();
    return;
  }
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const color = GRADIENT[i] || GRADIENT[GRADIENT.length - 1];
    logger.log(chalk.hex(color)(LOGO_LINES[i]));
  }
  renderTagline();
  logger.newLine();
}
