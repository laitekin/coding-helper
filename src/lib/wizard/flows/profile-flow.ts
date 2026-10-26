import ora from 'ora';
import { t } from '../../i18n.js';
import { configManager, type Profile } from '../../config.js';
import { validateApiKey } from '../../api-validator.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { menuPrompt, secretPrompt, type MenuEntry } from '../ui/prompts.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { syncAfterChange } from '../ui/tool-view.js';
import { pickEndpoint } from './endpoint-selection-flow.js';
import { isValidProfileName } from '../../core/quick-args.js';
import { toolManager } from '../../tool-manager.js';
import { modelService } from '../../model-service.js';
import { marketModelService } from '../../market-model-service.js';
import { theme } from '../ui/theme.js';
import { logger } from '../../../utils/logger.js';

const NEW = '__new__';

// 使用某个配置档的工具：单独绑定的 + 当前配置档下跟随的
export function toolsUsingProfile(name: string, ids = false): string[] {
  const active = configManager.getActiveProfile();
  return toolManager.getAll()
    .filter((tool) => !tool.launchOnly)
    .filter((tool) => {
      const pinned = configManager.getToolProfile(tool.name);
      try {
        return tool.isConfigured() && (pinned ? pinned === name : active === name);
      } catch {
        return false;
      }
    })
    .map((tool) => (ids ? tool.name : tool.displayName));
}

function profileRow(p: Profile, active: string | undefined): MenuEntry<string> {
  const tools = toolsUsingProfile(p.name);
  return {
    value: p.name,
    label: `${p.name === active ? theme.brand('●') : ' '} ${p.name}`,
    hint: `${uiRenderer.maskApiKey(p.apiKey)} · ${uiRenderer.endpointLabel(p.endpoint, p.baseUrl)}`,
    description: theme.subtle(tools.length ? t('profile_used_by', { tools: tools.join(' · ') }) : t('profile_unused')),
  };
}

// 配置档管理：回车打开某个配置档（使用 / 编辑 / 测试 / 删除），最后一行新建
export async function runProfileMenu(): Promise<void> {
  let last: string | undefined;
  while (true) {
    uiRenderer.renderPage(t('profile_title'));
    const profiles = configManager.listProfiles();
    const active = configManager.getActiveProfile();
    if (profiles.length === 0) {
      uiRenderer.renderHint(t('profile_empty_hint'));
      logger.newLine();
    }

    const { value, action } = await menuPrompt<string>({
      message: t('menu_select_action'),
      default: last ?? active,
      escape: true,
      items: [
        ...profiles.map((p) => profileRow(p, active)),
        ...(profiles.length ? [{ separator: '' }] : []),
        { value: NEW, label: t('profile_new') },
      ],
    });

    if (action === 'escape') return;
    last = value;
    if (value === NEW) {
      await createOrEditProfile();
      continue;
    }
    const profile = configManager.getProfile(value);
    if (profile) await profileActions(profile);
  }
}

// 一个配置档的操作
async function profileActions(profile: Profile): Promise<void> {
  uiRenderer.renderPage(t('profile_actions_title', { name: profile.name }), undefined,
    `${uiRenderer.maskApiKey(profile.apiKey)} · ${uiRenderer.endpointLabel(profile.endpoint, profile.baseUrl)}`);
  const active = configManager.getActiveProfile() === profile.name;
  const { value, action } = await menuPrompt<'use' | 'edit' | 'test' | 'delete'>({
    message: t('menu_select_action'),
    escape: true,
    items: [
      { value: 'use', label: t('profile_action_use'), hint: active ? t('profile_action_use_current') : '', disabled: active },
      { value: 'edit', label: t('profile_action_edit') },
      { value: 'test', label: t('profile_action_test') },
      { value: 'delete', label: t('profile_action_delete') },
    ],
  });
  if (action === 'escape') return;
  if (value === 'use') await useProfile(profile.name);
  else if (value === 'edit') await createOrEditProfile(profile);
  else if (value === 'test') await testProfile(profile);
  else await deleteProfile(profile);
}

// 切换当前配置档并同步到已接入的工具
export async function useProfile(name: string): Promise<void> {
  configManager.useProfile(name);
  modelService.clearCache();
  marketModelService.clearCache();
  uiRenderer.renderHeader();
  uiRenderer.renderSuccess(t('profile_switched', { name }));
  await syncAfterChange();
  await promptHelper.pressEnter(t('result_back_to_menu'));
}

async function createOrEditProfile(existing?: Profile): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(existing ? t('profile_edit_title', { name: existing.name }) : t('profile_new'));

  let name = existing?.name;
  while (!name) {
    const input = (await promptHelper.input(t('profile_name_prompt'))).trim();
    if (!input) return;
    if (!isValidProfileName(input)) uiRenderer.renderError(t('profile_name_invalid'));
    else if (configManager.getProfile(input)) uiRenderer.renderError(t('profile_name_exists', { name: input }));
    else name = input;
  }

  // 新建时可直接沿用当前 Key
  let apiKey = existing?.apiKey;
  const current = configManager.getApiKey();
  if (!existing && current && configManager.listProfiles().length === 0) {
    if (await promptHelper.confirm(t('profile_reuse_current', { key: uiRenderer.maskApiKey(current) }), true)) apiKey = current;
  }
  if (!apiKey || existing) {
    const input = await secretPrompt({
      message: existing ? t('profile_key_prompt_edit') : t('apikey_prompt'),
      hint: t('apikey_hint'),
      escape: true,
    });
    if (input === undefined) return;
    if (input) apiKey = input;
    if (!apiKey) return;
  }

  const picked = await pickEndpoint(existing?.endpoint ?? configManager.getEndpoint(), existing?.baseUrl);
  if (!picked) return;
  const [endpoint, customUrl] = picked;

  const draft: Profile = { name, apiKey, endpoint, baseUrl: customUrl ?? '' };
  configManager.saveProfile(name, apiKey, endpoint, customUrl);
  const saved = configManager.getProfile(name)!;
  draft.baseUrl = saved.baseUrl;
  const ok = await checkConnection(draft);
  if (!ok) uiRenderer.renderWarning(t('profile_saved_unverified', { name }));
  else uiRenderer.renderSuccess(t('profile_saved', { name }));

  // 第一个配置档：直接作为当前配置档
  if (!configManager.getActiveProfile()) {
    configManager.useProfile(name);
    uiRenderer.renderHint(t('profile_now_active', { name }));
  } else if (existing && configManager.getActiveProfile() === name) {
    await syncAfterChange();
  }
  await promptHelper.pressEnter();
}

async function checkConnection(p: Profile): Promise<boolean> {
  const spinner = ora({ text: t('apikey_validating'), indent: 2 }).start();
  const result = await validateApiKey(p.apiKey, p.baseUrl);
  if (result.valid) spinner.succeed(t('profile_test_ok', { name: p.name, endpoint: uiRenderer.endpointLabel(p.endpoint, p.baseUrl) }));
  else spinner.fail(t('profile_test_failed', { name: p.name, error: result.error ?? '' }));
  return result.valid;
}

async function testProfile(p: Profile): Promise<void> {
  uiRenderer.renderHeader();
  await checkConnection(p);
  await promptHelper.pressEnter();
}

async function deleteProfile(p: Profile): Promise<void> {
  uiRenderer.renderHeader();
  const tools = toolsUsingProfile(p.name);
  if (tools.length) logger.log(`  ${theme.warning(t('profile_delete_in_use', { tools: tools.join(' · ') }))}`);
  if (!(await promptHelper.confirm(t('profile_delete_confirm', { name: p.name }), false))) return;
  configManager.removeProfile(p.name);
  uiRenderer.renderSuccess(t('profile_deleted', { name: p.name }));
  // 原来绑定在它上面的工具改用当前连接
  if (tools.length) await syncAfterChange('sync_after_delete_prompt');
  await promptHelper.pressEnter();
}
