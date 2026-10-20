import { t, i18n, SUPPORTED_LOCALES, type Locale } from '../../i18n.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';

// 语言选择流程；首次向导时在进度条上方展示欢迎卡片
export async function runLanguageFlow(step?: { current: number; total: number }): Promise<void> {
  uiRenderer.renderHeader();
  if (step) {
    uiRenderer.renderWelcome(t('welcome'), t('welcome_description'), t('privacy_notice'));
    uiRenderer.renderSteps(step.current, step.total, t('menu_configure_language'));
  }
  const locale = await promptHelper.select<string>(t('language_prompt'), [
    { name: '中文', value: 'zh_CN' },
    { name: 'English', value: 'en_US' },
  ]);

  i18n.setLocale(locale as Locale);
  uiRenderer.renderSuccess(t('language_set', { lang: locale }));
}
