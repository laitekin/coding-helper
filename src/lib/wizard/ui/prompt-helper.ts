import { t } from '../../i18n.js';
import { menuPrompt, checkPrompt, secretPrompt, textPrompt, continuePrompt } from './prompts.js';

export const promptHelper = {
  async select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T> {
    const back = choices.find(choice => ['back', 'exit', '__back__'].includes(choice.value));
    const result = await menuPrompt({ message, escape: !!back, items: choices.map(choice => ({ value: choice.value, label: choice.name })) });
    return result.action === 'escape' ? back!.value : result.value;
  },
  async password(message: string): Promise<string> { return await secretPrompt({ message, escape: true }) ?? ''; },
  async input(message: string, defaultValue?: string): Promise<string> { return await textPrompt({ message, default: defaultValue }) ?? ''; },
  async confirm(message: string, defaultValue = true): Promise<boolean> {
    const choices = defaultValue ? [{ value: true, label: t('confirm_yes') }, { value: false, label: t('confirm_no') }]
      : [{ value: false, label: t('confirm_no') }, { value: true, label: t('confirm_yes') }];
    const result = await menuPrompt({ message, escape: true, items: choices });
    return result.action !== 'escape' && result.value;
  },
  async pressEnter(message?: string): Promise<void> { await continuePrompt(message ?? t('press_enter_to_continue')); },
  async checkbox<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T[]> {
    return await checkPrompt({ message, allowEmpty: true, items: choices.map(choice => ({ value: choice.value, label: choice.name })) }) ?? [];
  },
  async searchSelect(message: string, items: { name: string; value: string; description?: string }[], allowSkip = false): Promise<string | undefined> {
    const result = await menuPrompt({ message, escape: true, searchable: true,
      items: [...(allowSkip ? [{ value: '__skip__', label: t('model_skip_option') }] : []), ...items.map(item => ({ value: item.value, label: item.name, description: item.description }))],
      customLabel: query => t('model_custom_value', { value: query.trim() }) });
    return result.action === 'escape' || result.value === '__skip__' ? undefined : result.action === 'custom' ? result.query?.trim() || undefined : result.value;
  },
};
