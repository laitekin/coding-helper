import ora from 'ora';
import path from 'node:path';
import { t } from '../../i18n.js';
import { theme } from './theme.js';
import { uiRenderer } from './ui-renderer.js';
import { logger } from '../../../utils/logger.js';
import { padEnd, padVisible, truncate } from '../../../utils/string-width.js';
import type { ITool } from '../../tools/base-tool.js';
import { getSessionBackups, isDryRun, type PlannedChange } from '../../core/safe-write.js';
import { diffLines, withContext } from '../../../utils/line-diff.js';
import os from 'node:os';
import chalk from 'chalk';
import { configManager } from '../../config.js';
import { savedModelFor } from '../../core/model-mapping.js';
import { spriteColor } from './pixel.js';
import {
  applyTool,
  getSyncTargets,
  type ToolDetection,
  type ToolResult,
} from '../../core/tool-service.js';

// 安装状态文本：v1.2.3 / 未安装 / 桌面应用
export function formatInstallState(detection: ToolDetection): string {
  if (detection.installed === null) return theme.subtle(t('tool_badge_desktop'));
  if (!detection.installed) return theme.subtle(t('tool_badge_not_installed'));
  return theme.value(detection.version ? `v${detection.version}` : t('doctor_found'));
}

// 接入状态徽标：● 已接入七牛 / ○ 未接入
export function formatConfiguredBadge(detection: ToolDetection): string {
  return detection.configured
    ? theme.success(`● ${t('tool_badge_configured')}`)
    : theme.subtle(`○ ${t('tool_badge_not_configured')}`);
}

// 选择列表中的一行：名称、版本、接入状态按列对齐
export function formatToolChoice(detection: ToolDetection, nameWidth: number): string {
  const name = theme.value(padEnd(detection.tool.displayName, nameWidth));
  const install = padVisible(formatInstallState(detection), 12);
  return `${name}  ${install}  ${formatConfiguredBadge(detection)}`;
}

function formatResultStatus(result: ToolResult): string {
  switch (result.status) {
    case 'success': return theme.success(`✔ ${t('setup_status_success')}`);
    case 'skipped': return theme.warning(`– ${t('setup_status_skipped')}`);
    default: return theme.danger(`✖ ${t('setup_status_failed')}`);
  }
}

// 跳过原因是 i18n key，失败原因是错误信息
function reasonText(result: ToolResult): string {
  if (!result.reason) return '';
  const translated = t(result.reason);
  return translated === result.reason ? result.reason : translated;
}

function formatReason(result: ToolResult): string {
  return theme.subtle(truncate(reasonText(result), 60));
}

// 工具的小圆点：品牌色只出现在这里；未安装时为灰色空心圆
export function toolIcon(toolName: string, dim = false): string {
  if (dim) return theme.subtle('○');
  return chalk.level >= 2 ? chalk.hex(spriteColor(toolName))('●') : '●';
}

function launchHint(tool: ITool): string {
  return tool.isInstalled() === null ? t('result_restart_app', { tool: tool.displayName }) : tool.command;
}

// 结果页：亮起的像素角色 + 结果表 + 下一步（怎么启动、怎么撤销）+ 备份位置
export function renderResultSummary(results: ToolResult[], options: { restore?: boolean } = {}): void {
  if (results.length === 0) return;
  if (options.restore) {
    logger.newLine();
    uiRenderer.renderTable(
      [t('setup_col_tool'), t('setup_col_result'), t('setup_col_detail')],
      results.map((r) => [theme.value(r.tool.displayName), formatResultStatus(r), theme.subtle(truncate(reasonText(r), 48))]),
    );
    renderBackupHint();
    logger.newLine();
    return;
  }
  const ok = results.filter((r) => r.status === 'success');
  const headline = ok.length === results.length
    ? theme.success(`✔ ${t('result_headline_ok', { count: String(ok.length) })}`)
    : theme.warning(`! ${t('result_headline_partial', { ok: String(ok.length), total: String(results.length) })}`);
  logger.log(`  ${headline}`);
  logger.newLine();

  const models = configManager.getModels();
  uiRenderer.renderTable(
    [t('setup_col_tool'), t('setup_col_result'), t('result_col_model'), t('result_col_launch')],
    results.map((r) => [
      `${toolIcon(r.tool.name)} ${theme.value(r.tool.displayName)}`,
      formatResultStatus(r),
      r.status === 'success' ? theme.subtle(truncate(savedModelFor(r.tool, models) ?? r.tool.defaultModel ?? '—', 34)) : theme.subtle(truncate(reasonText(r), 34)),
      r.status === 'success' ? theme.brand(launchHint(r.tool)) : '',
    ]),
  );

  // 失败原因可能很长，表格里截断，完整信息列在表格下方
  for (const r of results.filter((x) => x.status === 'failed' && reasonText(x).length > 34)) {
    logger.newLine();
    logger.log(`  ${theme.danger('✖')} ${theme.value(r.tool.displayName)}`);
    logger.log(`    ${theme.subtle(reasonText(r))}`);
  }

  logger.newLine();
  if (ok.length > 0 && !isDryRun()) {
    const commands = ok.filter((r) => r.tool.isInstalled() !== null).map((r) => theme.value(r.tool.command));
    if (commands.length) logger.log(`  ${theme.brandBold(t('result_next'))}  ${t('result_next_launch', { commands: commands.join(theme.subtle(' / ')) })}`);
    logger.log(`  ${theme.subtle(t('result_undo'))}  ${theme.value('npx qiniu-coding-helper restore')}`);
  }
  renderBackupHint();
  logger.newLine();
}

function renderBackupHint(): void {
  const backups = getSessionBackups();
  if (backups.length === 0) return;
  logger.log(`  ${theme.subtle(t('setup_backup_hint', {
    count: String(backups.length),
    path: path.dirname(backups[0].backup).replace(os.homedir(), '~'),
  }))}`);
}

// 逐个装载并显示进度；返回每个客户端的结果
export async function applyToolsWithProgress(tools: ITool[]): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const tool of tools) {
    const spinner = ora({
      text: t('setup_applying', { tool: tool.displayName }),
      color: 'cyan',
      indent: 2,
    }).start();
    const result = await applyTool(tool);
    if (result.status === 'success') {
      spinner.succeed(t(isDryRun() ? 'dry_run_planned' : 'tool_config_loaded', { tool: tool.displayName }));
    }
    else if (result.status === 'skipped') spinner.warn(`${tool.displayName} ${theme.subtle(formatReason(result))}`);
    else spinner.fail(`${tool.displayName} ${theme.subtle(formatReason(result))}`);
    results.push(result);
  }
  return results;
}

// Key、线路或配置档变更后：列出仍指向七牛的工具，由用户勾选要更新哪些（默认勾选跟随当前连接的工具）；
// 不勾选 = 只保存到 coding-helper，不改工具配置。非交互终端不改动任何工具
export async function syncAfterChange(messageKey = 'sync_select_prompt'): Promise<ToolResult[]> {
  const targets = getSyncTargets();
  if (targets.length === 0 || !process.stdin.isTTY) return [];
  logger.newLine();
  const following = targets.filter((tool) => !configManager.getToolProfile(tool.name)).map((tool) => tool.name);
  const { selectTargets } = await import('./write-plan.js');
  const selected = await selectTargets(t(messageKey), targets, {
    preselect: following,
    detail: (tool) => {
      const profile = configManager.getToolProfile(tool.name);
      return profile ? t('sync_detail_pinned', { name: profile }) : t('sync_detail_following');
    },
    footer: [['space', t('ui_key_toggle')], ['a', t('ui_key_select_all_short')], ['n', t('ui_key_select_none')], ['⏎', t('sync_key_confirm')]],
  });
  if (selected.length === 0) {
    uiRenderer.renderHint(t('sync_skipped'));
    return [];
  }
  const results = await applyToolsWithProgress(selected);
  renderResultSummary(results);
  return results;
}

// --dry-run：逐个文件展示将要发生的变更，API Key 打码
export function renderPlannedChanges(changes: PlannedChange[], apiKey: string | undefined, options: { footer?: boolean } = {}): void {
  const mask = (text: string): string =>
    apiKey ? text.split(apiKey).join(uiRenderer.maskApiKey(apiKey)) : text;
  const display = (file: string): string => file.replace(os.homedir(), '~');

  if (changes.length === 0) {
    uiRenderer.renderHint(t('dry_run_no_changes'));
    return;
  }
  for (const change of changes) {
    const label = change.after === undefined
      ? t('dry_run_delete')
      : change.before === undefined ? t('dry_run_create') : t('dry_run_modify');
    logger.log(`  ${theme.brandBold(label)} ${theme.value(display(change.file))}`);
    for (const line of withContext(diffLines(change.before ?? '', change.after ?? ''))) {
      if (!line) {
        logger.log(theme.subtle('    …'));
        continue;
      }
      // 超长行（如 Codex 模型目录）截断显示
      const text = truncate(mask(line.text), 100);
      if (line.kind === '+') logger.log(theme.success(`  + ${text}`));
      else if (line.kind === '-') logger.log(theme.danger(`  - ${text}`));
      else logger.log(theme.subtle(`    ${text}`));
    }
    logger.newLine();
  }
  if (options.footer !== false) uiRenderer.renderHint(t('dry_run_footer'));
}
