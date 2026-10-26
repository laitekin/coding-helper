import { t, i18n, SUPPORTED_LOCALES, type Locale } from '../../i18n.js';
import { uiRenderer, type StepInfo } from '../ui/ui-renderer.js';
import { menuPrompt } from '../ui/prompts.js';

// 语言选择流程；首次向导时在进度条上方展示欢迎卡片
export async function runLanguageFlow(step?: StepInfo): Promise<boolean> {
  if (step) {
    uiRenderer.renderHeader();
    uiRenderer.renderWelcome(t('welcome'), t('welcome_description'), t('privacy_notice'));
    uiRenderer.renderSteps(step.current, step.total, t('menu_configure_language'), step.keys);
  }
  const { value: locale, action } = await menuPrompt<string>({
    message: t('language_prompt'),
    default: i18n.getLocale(),
    // 向导第一步没有上一步
    escape: !step,
    items: [
      { value: 'zh_CN', label: '简体中文' },
      { value: 'en_US', label: 'English' },
    ],
  });
  if (action === 'escape') return false;

  i18n.setLocale(locale as Locale);
  uiRenderer.renderSuccess(t('language_set', { lang: locale }));
  return true;
}
