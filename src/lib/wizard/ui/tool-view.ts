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

// 汇总表 + 备份位置提示
export function renderResultSummary(results: ToolResult[]): void {
  if (results.length === 0) return;
  logger.newLine();
  uiRenderer.renderTable(
    [t('setup_col_tool'), t('setup_col_result'), t('setup_col_detail')],
    results.map((r) => [theme.value(r.tool.displayName), formatResultStatus(r), theme.subtle(truncate(reasonText(r), 48))]),
  );

  // 失败原因可能很长，表格里截断，完整信息列在表格下方
  for (const r of results.filter((x) => x.status === 'failed' && reasonText(x).length > 48)) {
    logger.newLine();
    logger.log(`  ${theme.danger('✖')} ${theme.value(r.tool.displayName)}`);
    logger.log(`    ${theme.subtle(reasonText(r))}`);
  }

  const backups = getSessionBackups();
  if (backups.length > 0) {
    logger.newLine();
    uiRenderer.renderHint(t('setup_backup_hint', {
      count: String(backups.length),
      path: path.dirname(backups[0].backup),
    }));
  }
  logger.newLine();
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

// API Key 或线路变更后，同步到已接入的客户端
export async function syncAfterChange(): Promise<ToolResult[]> {
  const targets = getSyncTargets();
  if (targets.length === 0) return [];
  logger.newLine();
  uiRenderer.renderHint(t('sync_start', { count: String(targets.length) }));
  const results = await applyToolsWithProgress(targets);
  renderResultSummary(results);
  return results;
}

// --dry-run：逐个文件展示将要发生的变更，API Key 打码
export function renderPlannedChanges(changes: PlannedChange[], apiKey: string | undefined): void {
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
  uiRenderer.renderHint(t('dry_run_footer'));
}
