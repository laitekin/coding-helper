import { pickEndpoint } from './endpoint-selection-flow.js';
import { CUSTOM_ENDPOINT } from '../../endpoints.js';
import { configManager } from '../../config.js';
import { toolManager } from '../../tool-manager.js';
import { profileUseCommand, profileRemoveCommand, profileAddCommand } from '../../../commands/profile.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { t } from '../../i18n.js';
export function toolsUsingProfile(name: string): string[] { return toolManager.getAll().filter(tool => configManager.getConnection(tool.name).profile === name).map(tool => tool.name); }
export async function runProfileFlow(): Promise<void> {
  const action = await promptHelper.select(t('profile_title'), [{ name: t('profile_add'), value: '__add__' }, { name: t('tool_back'), value: 'back' }, ...configManager.listProfiles().map(profile => ({ name: profile.name, value: 'profile:' + profile.name }))]);
  if (action === 'back') return;
  if (action === '__add__') {
    const name = await promptHelper.input(t('profile_name_prompt')); if (!name) return;
    const endpoint = await pickEndpoint(); if (!endpoint) return;
    const key = await promptHelper.password(t('apikey_prompt'));
    if (key) await profileAddCommand(name, key, { intl: endpoint[0] === 'international', baseUrl: endpoint[0] === CUSTOM_ENDPOINT ? endpoint[1] : undefined });
    return;
  }
  const name = action.slice('profile:'.length);
  const operation = await promptHelper.select(name, [{ name: t('profile_use'), value: 'use' }, { name: t('profile_remove'), value: 'remove' }, { name: t('confirm_no'), value: 'back' }]);
  if (operation === 'use') await profileUseCommand(name);
  if (operation === 'remove' && await promptHelper.confirm(t('profile_remove'), false)) await profileRemoveCommand(name);
}
