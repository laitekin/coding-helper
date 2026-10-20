import ora from 'ora';
import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { validateApiKey, checkAccountStatus, describeAccountStatus } from '../../api-validator.js';
import { CUSTOM_ENDPOINT, getBaseUrl, otherEndpoint } from '../../endpoints.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { secretPrompt } from '../ui/prompts.js';
import { modelService } from '../../model-service.js';
import { marketModelService } from '../../market-model-service.js';
import { syncAfterChange } from '../ui/tool-view.js';
import { logger } from '../../../utils/logger.js';
import { theme } from '../ui/theme.js';

function render(step?: { current: number; total: number }): void {
  uiRenderer.renderHeader();
  if (step) uiRenderer.renderSteps(step.current, step.total, t('menu_configure_apikey'));
}

// 逐条校验：格式 → Key 有效（当前线路不通时自动试另一条）→ 账户可用 → 可用模型数
async function verifyKey(apiKey: string): Promise<boolean> {
  if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(apiKey)) {
    logger.log(`  ${theme.danger('✖')} ${t('apikey_check_format')}  ${theme.subtle(t('apikey_check_format_bad'))}`);
    return false;
  }
  logger.log(`  ${theme.success('✔')} ${t('apikey_check_format')}  ${theme.subtle(t('apikey_check_format_ok', { count: String(apiKey.length) }))}`);

  const spinner = ora({ text: t('apikey_validating'), indent: 2 }).start();
  let endpoint = configManager.getEndpoint();
  let baseUrl = configManager.baseUrl;
  let result = await validateApiKey(apiKey, baseUrl);
  if (!result.valid && endpoint !== CUSTOM_ENDPOINT) {
    // Key 可能属于另一条线路
    const other = otherEndpoint(endpoint);
    const retry = await validateApiKey(apiKey, getBaseUrl(other));
    if (retry.valid) {
      endpoint = other;
      baseUrl = getBaseUrl(other);
      configManager.setEndpoint(other);
      result = retry;
      spinner.info(t('apikey_endpoint_switched', { endpoint: uiRenderer.endpointLabel() }));
      spinner.start(t('apikey_validating'));
    }
  }
  if (!result.valid) {
    spinner.fail(t('apikey_invalid', { error: result.error || '' }));
    return false;
  }
  spinner.succeed(`${t('apikey_check_valid')}  ${theme.subtle(uiRenderer.endpointLabel())}`);

  const account = ora({ text: t('apikey_check_account_running'), indent: 2 }).start();
  const status = await checkAccountStatus(apiKey, baseUrl);
  if (!status.usable) {
    account.fail(describeAccountStatus(status));
    return false;
  }
  account.succeed(t('apikey_check_account'));

  try {
    const models = await modelService.fetchModels(baseUrl, apiKey);
    logger.log(`  ${theme.success('✔')} ${t('apikey_check_models', { count: String(models.length) })}`);
  } catch {
    // 模型列表只是信息展示，失败不影响结论
  }
  return true;
}

// API Key 输入和验证流程；step 用于首次向导的进度展示
export async function runApiKeyFlow(step?: { current: number; total: number }): Promise<boolean> {
  while (true) {
    render(step);
    const apiKey = await secretPrompt({
      message: t('apikey_prompt'),
      hint: t('apikey_hint_short'),
      escape: !step,
      footer: [['⏎', t('ui_key_confirm')], ['ctrl+v', t('ui_key_paste')], ...(!step ? [['esc', t('ui_key_back')] as [string, string]] : [])],
    });
    if (!apiKey) {
      if (!step) return false;
      uiRenderer.renderError(t('apikey_empty'));
      if (!(await promptHelper.confirm(t('apikey_retry')))) return false;
      continue;
    }

    logger.newLine();
    if (await verifyKey(apiKey)) {
      const changed = configManager.getApiKey() !== apiKey;
      configManager.setApiKey(apiKey);
      // 新 API Key 需要清除模型缓存
      modelService.clearCache();
      marketModelService.clearCache();
      logger.newLine();
      uiRenderer.renderSuccess(t('apikey_saved'));
      // 换 Key 后同步到已接入的客户端
      if (!step && changed) await syncAfterChange();
      if (!step) await promptHelper.pressEnter();
      return true;
    }

    logger.newLine();
    if (!(await promptHelper.confirm(t('apikey_retry')))) return false;
  }
}
