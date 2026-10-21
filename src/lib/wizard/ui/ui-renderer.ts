import chalk from 'chalk';
import { stringWidth, padEnd, truncate, visibleWidth, padVisible } from '../../../utils/string-width.js';
import { logger } from '../../../utils/logger.js';
import { renderLogo as renderLogoArt } from './logo.js';
import { theme } from './theme.js';
import { configManager } from '../../config.js';
import { ENDPOINT_DEFINITIONS } from '../../endpoints.js';
import { t } from '../../i18n.js';
import { registeredTools } from '../../tool-registry.js';

// 配置面板条目
export interface ConfigPanelItem {
  label: string;
  value: string;
  configured: boolean;
}

// 首次向导的步骤
export const WIZARD_STEP_KEYS = ['step_language', 'step_endpoint', 'step_apikey', 'step_tools', 'step_model', 'step_confirm'];
// 接入 / 切换模型的步骤：选工具 → 选模型 → 确认
export const FLOW_STEP_KEYS = ['step_tools', 'step_model', 'step_confirm'];

// 流程进度：第几步、共几步、各步名称（默认为首次向导）
export interface StepInfo {
  current: number;
  total: number;
  keys?: string[];
}

// 配置文件当前指向七牛的工具
export function connectedToolNames(): string[] {
  return registeredTools().filter((tool) => {
    if (tool.launchOnly) return false;
    try {
      return tool.isConfigured();
    } catch {
      return false;
    }
  }).map((tool) => tool.name);
}

// 终端 UI 渲染器
export const uiRenderer = {
  // 清屏 - 清除终端内容和滚动缓冲区
  clearScreen(): void {
    process.stdout.write('\x1Bc');
  },

  // 渲染七牛 Logo（只在主菜单与首次向导使用）
  renderLogo(): void {
    renderLogoArt();
  },

  // 页头。full：像素 Logo + 状态行（主菜单、首次向导）；否则一行品牌 + 面包屑 + 状态，内容页保持安静
  renderHeader(options: { full?: boolean; crumb?: string } = {}): void {
    this.clearScreen();
    if (options.full) {
      this.renderLogo();
      this.renderStatusBar();
      return;
    }
    logger.newLine();
    const brand = `${theme.brandBold('QINIU')} ${chalk.bold.hex('#E8F6FF')('Coding Helper')}`;
    const crumb = options.crumb ? `${theme.subtle('  ›  ')}${theme.value(options.crumb)}` : '';
    logger.log(`  ${brand}${crumb}`);
    this.renderStatusBar();
  },

  // 状态行：● 国内线路 (api.qnaigc.com) · Key sk-c…70c7 · 已接入 6 / 12 · 配置档 work
  renderStatusBar(): void {
    const apiKey = configManager.getApiKey();
    const tools = registeredTools().filter((tool) => !tool.launchOnly);
    const applied = connectedToolNames().length;

    const sep = theme.subtle('  ·  ');
    const segments = [
      `${theme.success('●')} ${theme.subtle(this.endpointLabel())}`,
      `${theme.subtle('Key')} ${apiKey ? theme.subtle(this.maskApiKey(apiKey)) : theme.warning(t('config_view_not_set'))}`,
      `${theme.subtle(t('status_applied'))} ${theme.brand(String(applied))}${theme.subtle(` / ${tools.length}`)}`,
    ];
    const profile = configManager.getActiveProfile();
    if (profile) segments.push(`${theme.subtle(t('profile_label'))} ${theme.brand(profile)}`);

    const columns = process.stdout.columns || 100;
    const line = segments.join(sep);
    if (visibleWidth(line) + 4 <= columns) {
      logger.log(`  ${line}`);
    } else {
      logger.log(`  ${segments.slice(0, 2).join(sep)}`);
      logger.log(`  ${segments.slice(2).join(sep)}`);
    }
    logger.log(`  ${theme.border('─'.repeat(Math.min(columns - 4, 72)))}`);
    logger.newLine();
  },

  // 当前线路的显示名：国内线路 (api.qnaigc.com) / 自定义 https://…
  endpointLabel(endpointId = configManager.getEndpoint(), baseUrl = configManager.baseUrl): string {
    const def = ENDPOINT_DEFINITIONS[endpointId];
    return def ? t(def.i18nKey) : `${t('endpoint_custom')} ${baseUrl.replace(/^https?:\/\//, '')}`;
  },

  // 渲染欢迎界面（圆角卡片）
  renderWelcome(title: string, description: string, privacyNotice: string): void {
    const lines = [theme.brandBold(title), '', theme.value(description), theme.subtle(privacyNotice)];
    const inner = Math.max(46, ...lines.map(visibleWidth)) + 4;
    logger.log(`  ${theme.border('╭' + '─'.repeat(inner) + '╮')}`);
    for (const l of lines) {
      logger.log(`  ${theme.border('│')}  ${padVisible(l, inner - 2)}${theme.border('│')}`);
    }
    logger.log(`  ${theme.border('╰' + '─'.repeat(inner) + '╯')}`);
    logger.newLine();
  },

  // 页面标题：粗体标题 + 可选的一行说明
  renderTitle(title: string, subtitle?: string): void {
    logger.log(`  ${chalk.bold.hex('#E8F6FF')(title)}`);
    if (subtitle) logger.log(`  ${theme.subtle(subtitle)}`);
    logger.newLine();
  },

  // 内容页页头：紧凑页头 + 进度条（流程中）或标题
  renderPage(title: string, step?: StepInfo, subtitle?: string): void {
    this.renderHeader();
    if (step) {
      this.renderSteps(step.current, step.total, title, step.keys);
      if (subtitle) {
        logger.log(`  ${theme.subtle(subtitle)}`);
        logger.newLine();
      }
    } else {
      this.renderTitle(title, subtitle);
    }
  },

  // 向导进度条：● 语言 ── ● 线路 ── ◉ API Key ── ○ 工具 ── ○ 模型   3/5
  renderSteps(current: number, total: number, _title?: string, keys: string[] = WIZARD_STEP_KEYS): void {
    const labels = keys.slice(0, total).map((key) => t(key));
    const parts = labels.map((label, i) => {
      if (i < current - 1) return `${theme.success('●')} ${theme.value(label)}`;
      if (i === current - 1) return `${theme.brandBold('◉')} ${chalk.bold.hex('#E8F6FF')(label)}`;
      return `${theme.subtle('○')} ${theme.subtle(label)}`;
    });
    logger.log(`  ${parts.join(theme.border(' ── '))}   ${theme.subtle(`${Math.min(current, total)} / ${total}`)}`);
    logger.newLine();
  },

  // 渲染圆角表格：表头 + 行，单元格可带颜色
  renderTable(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, col) => Math.max(
      visibleWidth(header),
      ...rows.map((row) => visibleWidth(row[col] ?? '')),
    ));
    const line = (left: string, mid: string, right: string): string =>
      `  ${theme.border(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right)}`;
    const row = (cells: string[]): string =>
      `  ${theme.border('│')}${cells.map((cell, i) => ` ${padVisible(cell, widths[i])} `).join(theme.border('│'))}${theme.border('│')}`;

    logger.log(line('╭', '┬', '╮'));
    logger.log(row(headers.map((h) => theme.label(h))));
    logger.log(line('├', '┼', '┤'));
    for (const r of rows) logger.log(row(r));
    logger.log(line('╰', '┴', '╯'));
  },

  // 渲染带边框的配置面板卡片（动态宽度，自适应内容）
  renderConfigPanel(items: ConfigPanelItem[]): void {
    if (items.length === 0) return;

    const MIN_INNER_WIDTH = 40;  // 最小内宽，保持美观
    const MAX_INNER_WIDTH = 70;  // 最大内宽，防止面板过宽
    const OVERHEAD = 4;          // 每行固定开销：空格(1) + 圆点(1) + 空格(1) + 标签后空格(1)

    // 动态计算标签列宽度：取所有标签中最大可见宽度
    const labelWidth = Math.max(...items.map(item => stringWidth(item.label)));
    // 动态计算值列宽度：取所有值中最大可见宽度
    const maxValueWidth = Math.max(...items.map(item => stringWidth(item.value)));
    // 计算所需内宽并约束在 [MIN, MAX] 范围内
    const neededWidth = OVERHEAD + labelWidth + maxValueWidth;
    const innerWidth = Math.max(MIN_INNER_WIDTH, Math.min(MAX_INNER_WIDTH, neededWidth));
    // 可用的值列最大宽度（超出时截断）
    const maxAllowedValueWidth = innerWidth - OVERHEAD - labelWidth;

    const topBorder    = `  ${theme.border('╭' + '─'.repeat(innerWidth) + '╮')}`;
    const bottomBorder = `  ${theme.border('╰' + '─'.repeat(innerWidth) + '╯')}`;
    const midBorder    = `  ${theme.border('├' + '─'.repeat(innerWidth) + '┤')}`;

    logger.log(topBorder);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // 状态圆点：已配置绿色 ●，未配置灰色 ○
      const dot = item.configured
        ? theme.accent('●')
        : theme.subtle('○');
      const label = theme.label(padEnd(item.label, labelWidth));

      // 值超出可用宽度时截断
      const displayValue = stringWidth(item.value) > maxAllowedValueWidth
        ? truncate(item.value, maxAllowedValueWidth)
        : item.value;
      const val = item.configured
        ? theme.value(displayValue)
        : theme.muted(displayValue);

      // 计算可见宽度来精确对齐右边框
      const valueVisibleWidth = stringWidth(displayValue);
      const contentVisibleWidth = 1 + 1 + 1 + labelWidth + 1 + valueVisibleWidth;
      const padding = Math.max(0, innerWidth - contentVisibleWidth);

      logger.log(`  ${theme.border('│')} ${dot} ${label} ${val}${' '.repeat(padding)}${theme.border('│')}`);

      // 中间分隔线（不在最后一项后面）
      if (i < items.length - 1) {
        logger.log(midBorder);
      }
    }

    logger.log(bottomBorder);
    logger.newLine();
  },

  // 渲染键值对配置信息
  renderConfigItem(label: string, value: string | undefined, targetWidth = 16): void {
    const paddedLabel = padEnd(label, targetWidth);
    const displayValue = value || chalk.dim('N/A');
    logger.log(`  ${chalk.bold(paddedLabel)} ${displayValue}`);
  },

  // 渲染模型配置项，未配置时灰显"未设置"
  renderModelConfigItem(label: string, value: string | undefined): void {
    this.renderConfigItem(label, value || chalk.dim(t('model_confirm_not_set')));
  },

  // 渲染分隔线
  renderDivider(): void {
    logger.log(chalk.dim('─'.repeat(50)));
  },

  // 渲染灰色提示信息（次要文案）
  renderHint(message: string): void {
    logger.log(chalk.dim(`  ${message}`));
  },

  // 渲染成功消息
  renderSuccess(message: string): void {
    logger.success(message);
  },

  // 渲染错误消息
  renderError(message: string): void {
    logger.error(message);
  },

  // 渲染警告消息
  renderWarning(message: string): void {
    logger.warn(message);
  },

  // 遮蔽 API Key，只显示前4位和后4位
  maskApiKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  },
};
