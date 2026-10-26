import inquirer from 'inquirer';
import search from '@inquirer/search';
import { t } from '../../i18n.js';
import { theme } from './theme.js';
import { continuePrompt, menuPrompt, textPrompt } from './prompts.js';

// 搜索选择的跳过标记
const SKIP_VALUE = '__skip__';

// inquirer 封装 - 统一交互式 prompt
export const promptHelper = {
  // 单选列表（统一用新菜单样式）
  async select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T> {
    const { value } = await menuPrompt<T>({
      message,
      items: choices.map((choice) => ({ value: choice.value, label: choice.name })),
    });
    return value;
  },

  // 密码/隐藏输入
  async password(message: string): Promise<string> {
    const { answer } = await inquirer.prompt([
      {
        type: 'password',
        name: 'answer',
        message,
        mask: '*',
      },
    ]);
    return answer as string;
  },

  // 文本输入；按 Esc 返回空字符串（调用方按「取消」处理）
  async input(message: string, defaultValue?: string): Promise<string> {
    return (await textPrompt({ message, default: defaultValue })) ?? '';
  },

  // 确认：y / n 直接选择
  async confirm(message: string, defaultValue = true): Promise<boolean> {
    const yes = { value: true, key: 'y', label: `${theme.icon('✔')} ${t('confirm_yes')}` };
    const no = { value: false, key: 'n', label: `${theme.dimIcon('✘')} ${t('confirm_no')}` };
    const { value, action } = await menuPrompt<boolean>({
      message,
      items: defaultValue ? [yes, no] : [no, yes],
      escape: true,
    });
    // Esc 视为取消
    return action === 'escape' ? false : value;
  },

  // 按回车（或 Esc）继续
  async pressEnter(message?: string): Promise<void> {
    await continuePrompt(message || t('press_enter_to_continue'));
  },

  // 多选列表
  async checkbox<T extends string>(
    message: string,
    choices: { name: string; value: T; checked?: boolean }[],
  ): Promise<T[]> {
    const { answer } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'answer',
        message,
        choices,
        pageSize: 15,
        loop: false,
      },
    ]);
    return answer as T[];
  },

  // 搜索+自动补全选择（同时展示输入框和可滚动列表，支持自定义输入和跳过）
  async searchSelect(
    message: string,
    items: { name: string; value: string; description?: string }[],
    allowSkip = false,
  ): Promise<string | undefined> {
    const answer = await search({
      message,
      pageSize: 10,
      source: async (term) => {
        const results: { name: string; value: string; description?: string }[] = [];

        // 始终在顶部添加跳过选项
        if (allowSkip) {
          results.push({
            name: `⊘ ${t('model_skip_option')}`,
            value: SKIP_VALUE,
          });
        }

        const keyword = (term || '').trim().toLowerCase();

        if (!keyword) {
          // 无输入时显示完整列表
          results.push(...items);
          return results;
        }

        // 根据输入过滤列表
        const filtered = items.filter(
          (item) =>
            item.name.toLowerCase().includes(keyword) ||
            item.value.toLowerCase().includes(keyword),
        );

        // 如果用户输入的值不匹配任何现有项，在列表头部注入自定义值选项
        const exactMatch = items.some(
          (item) => item.value.toLowerCase() === keyword,
        );
        if (!exactMatch) {
          results.push({
            name: `✎ ${t('model_custom_value', { value: term || '' })}`,
            value: (term || '').trim(),
          });
        }

        results.push(...filtered);
        return results;
      },
    });

    // 跳过时返回 undefined
    if (answer === SKIP_VALUE) {
      return undefined;
    }

    return (answer as string).trim() || undefined;
  },
};
