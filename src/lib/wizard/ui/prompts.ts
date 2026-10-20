import {
  createPrompt,
  useKeypress,
  useState,
  usePagination,
  useMemo,
  isEnterKey,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isBackspaceKey,
  type KeypressEvent,
} from '@inquirer/core';
import chalk from 'chalk';
import { theme } from './theme.js';
import { t } from '../../i18n.js';
import { padVisible, visibleWidth, truncate } from '../../../utils/string-width.js';

// 底部快捷键条：[按键, 说明]
export type KeyHint = [string, string];

const ACTIVE_BG = '#0F2633';

// 光标隐藏（与 @inquirer/select 一致，避免闪烁）
const CURSOR_HIDE = '\x1B[?25l';

function sequenceOf(key: KeypressEvent): string {
  return (key as KeypressEvent & { sequence?: string }).sequence ?? '';
}

function isEscape(key: KeypressEvent): boolean {
  return key.name === 'escape';
}

// 快捷键条：放不下时按整组换行，不把一组拆开
export function renderKeyHints(hints: KeyHint[]): string {
  const max = terminalWidth() - 4;
  const lines: string[] = [];
  let line = '';
  for (const [k, text] of hints) {
    const part = `${chalk.hex('#C9D3DC').bgHex('#1C2733')(` ${k} `)} ${theme.subtle(text)}`;
    if (line && visibleWidth(line) + 2 + visibleWidth(part) > max) {
      lines.push(line);
      line = part;
    } else {
      line = line ? `${line}  ${part}` : part;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n  ');
}

function terminalWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 100, 140));
}

// 右侧值放不下时整列隐藏（选中项的说明里仍有完整信息）
function hintFits(prefix: number, labelWidth: number, hintWidth: number): boolean {
  return prefix + labelWidth + 4 + hintWidth <= terminalWidth() - 2;
}

// 选中行：整行铺底色
function highlightRow(text: string, width: number): string {
  return chalk.bgHex(ACTIVE_BG)(padVisible(text, width));
}

// ─── 菜单 ─────────────────────────────────────────────────────────

export interface MenuItem<T> {
  value: T;
  label: string;
  // 右侧的当前值/状态
  hint?: string;
  // 选中时显示在列表下方
  description?: string;
  // 快捷键：按下直接选中并确认（数字或字母）
  key?: string;
  // 左侧图标（已着色），需定宽
  icon?: string;
  disabled?: boolean;
  // 搜索时额外匹配的文本
  search?: string;
}

export interface MenuSeparator {
  separator: string;
}

export type MenuEntry<T> = MenuItem<T> | MenuSeparator;

export interface MenuConfig<T> {
  message: string;
  items: MenuEntry<T>[];
  default?: T;
  footer?: KeyHint[];
  // 作用于当前选中项的快捷键（如 m 换模型），按下后返回 { value, action }
  actions?: string[];
  // 允许 esc 返回（返回 action 'escape'）
  escape?: boolean;
  // 按 / 进入搜索
  searchable?: boolean;
  // 搜索时附加「使用输入的值」，选中返回 action 'custom' 与 query
  customLabel?: (query: string) => string;
  pageSize?: number;
}

export interface MenuResult<T> {
  value: T;
  // 触发的快捷操作；回车或 item.key 时为 undefined
  action?: string;
  query?: string;
}

function isSeparator<T>(entry: MenuEntry<T>): entry is MenuSeparator {
  return 'separator' in entry;
}

function selectable<T>(entry: MenuEntry<T>): entry is MenuItem<T> {
  return !isSeparator(entry) && !entry.disabled;
}

const CUSTOM = Symbol('custom');

const menuView = createPrompt(<T,>(config: MenuConfig<T>, done: (result: MenuResult<T>) => void) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<'idle' | 'done'>('idle');

  // 搜索时只显示匹配项，末尾可附「使用输入的值」
  const items = useMemo((): MenuEntry<T | typeof CUSTOM>[] => {
    if (!query) return config.items;
    const q = query.toLowerCase();
    const matched = config.items.filter((e): e is MenuItem<T> =>
      selectable(e) && `${e.search ?? ''} ${e.label} ${String(e.value)}`.toLowerCase().includes(q));
    const custom: MenuItem<typeof CUSTOM>[] = config.customLabel ? [{ value: CUSTOM, label: config.customLabel(query) }] : [];
    return [...matched, ...custom];
  }, [query, config.items]);

  const first = items.findIndex(selectable);
  const last = items.length - 1 - [...items].reverse().findIndex(selectable);
  const defaultIndex = config.default === undefined ? -1 : items.findIndex((e) => selectable(e) && e.value === config.default);
  const [active, setActive] = useState(defaultIndex === -1 ? first : defaultIndex);
  const activeIndex = selectable(items[active] ?? { separator: '' }) ? active : first;

  const finish = (result: MenuResult<T>): void => {
    setStatus('done');
    done(result);
  };

  const updateQuery = (next: string): void => {
    setQuery(next);
    setActive(0);
  };

  useKeypress((key) => {
    const current = activeIndex >= 0 ? items[activeIndex] as MenuItem<T | typeof CUSTOM> : undefined;
    if (isEnterKey(key)) {
      if (!current) return;
      if (current.value === CUSTOM) return finish({ value: undefined as T, action: 'custom', query });
      return finish({ value: current.value as T, query });
    }
    if (isEscape(key)) {
      if (searching || query) {
        setSearching(false);
        updateQuery('');
        return;
      }
      if (config.escape && current) finish({ value: current.value as T, action: 'escape' });
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      if (activeIndex < 0) return;
      const offset = isUpKey(key) ? -1 : 1;
      let next = activeIndex;
      do {
        next += offset;
      } while (next >= first && next <= last && !selectable(items[next]));
      if (next >= first && next <= last) setActive(next);
      return;
    }
    const seq = sequenceOf(key);
    if (searching) {
      if (isBackspaceKey(key)) updateQuery(query.slice(0, -1));
      else if (seq && !key.ctrl && seq >= ' ' && seq.length === 1) updateQuery(query + seq);
      return;
    }
    if (!seq || key.ctrl) return;
    if (seq === '/' && config.searchable) {
      setSearching(true);
      return;
    }
    const hit = items.findIndex((e) => selectable(e) && e.key === seq);
    if (hit !== -1) {
      setActive(hit);
      return finish({ value: (items[hit] as MenuItem<T>).value });
    }
    if (current && config.actions?.includes(seq) && current.value !== CUSTOM) finish({ value: current.value as T, action: seq });
  });

  const all = config.items.filter((e): e is MenuItem<T> => !isSeparator(e));
  const labelWidth = Math.max(0, ...all.map((e) => visibleWidth(e.label)));
  const iconWidth = Math.max(0, ...all.map((e) => (e.icon ? visibleWidth(e.icon) + 1 : 0)));
  const showHints = hintFits(7 + iconWidth, labelWidth, Math.max(0, ...all.map((e) => visibleWidth(e.hint ?? ''))));
  const hintOf = (item: MenuItem<unknown>): string => (showHints ? item.hint ?? '' : '');
  // 选中行底色铺满：前缀「 ❯  k  」7 列 + 图标 + 标签 + 4 列间距 + 右侧值 + 2 列留白
  const width = Math.min(terminalWidth() - 2, Math.max(
    48,
    ...all.map((e) => 7 + iconWidth + labelWidth + 4 + visibleWidth(hintOf(e)) + 2),
  ));

  const page = usePagination({
    items,
    active: Math.max(0, activeIndex),
    pageSize: config.pageSize ?? 14,
    loop: false,
    renderItem({ item, isActive }) {
      if (isSeparator(item)) return `  ${theme.subtle(item.separator)}`;
      const key = item.key ? item.key : ' ';
      const icon = item.icon ? `${item.icon} ` : '';
      if (item.disabled) {
        return `    ${theme.subtle(key)}  ${icon}${theme.subtle(padVisible(item.label, labelWidth))}    ${theme.subtle(hintOf(item))}`;
      }
      if (isActive) {
        const text = ` ${theme.brandBold('❯')}  ${theme.brand(key)}  ${icon}${chalk.bold.hex('#E8F6FF')(padVisible(item.label, labelWidth))}    ${chalk.hex('#8BE9FF')(hintOf(item))}`;
        return highlightRow(text, width);
      }
      return `    ${theme.subtle(key)}  ${icon}${theme.value(padVisible(item.label, labelWidth))}    ${theme.subtle(hintOf(item))}`;
    },
  });

  const current = activeIndex >= 0 ? items[activeIndex] as MenuItem<T> : undefined;
  if (status === 'done') {
    return `${theme.success('✔')} ${theme.heading(config.message)} ${theme.brand(current?.value === CUSTOM ? query : current?.label ?? '')}`;
  }
  const lines = [`${theme.brand('?')} ${theme.heading(config.message)}`];
  if (searching || query) {
    lines.push(`  ${theme.brand('/')} ${theme.value(query)}${chalk.bgHex('#19C2F0')(' ')}  ${theme.subtle(t('ui_search_matches', { count: String(items.filter((e) => selectable(e) && (e as MenuItem<unknown>).value !== CUSTOM).length) }))}`);
  }
  lines.push(items.length ? page : `  ${theme.subtle(t('ui_search_empty'))}`);
  if (current?.description) {
    lines.push('');
    for (const line of current.description.split('\n')) lines.push(`  ${line}`);
  }
  if (config.footer?.length) {
    lines.push('', `  ${renderKeyHints(searching ? [['esc', t('ui_key_clear_search')], ['⏎', t('ui_key_confirm')]] : config.footer)}`);
  }
  return `${lines.join('\n')}${CURSOR_HIDE}`;
});

// ─── 多选（宽终端两列） ───────────────────────────────────────────

export interface CheckItem<T> {
  value: T;
  label: string;
  icon?: string;
  tag?: string;
  checked?: boolean;
  // a 键「全选」时选中的项（如已安装的工具）
  preferred?: boolean;
}

export interface CheckConfig<T> {
  message: string;
  items: CheckItem<T>[];
  footer?: KeyHint[];
  // 根据当前勾选生成底部提示
  summary?: (values: T[]) => string;
  columns?: number;
}

const checkView = createPrompt(<T,>(config: CheckConfig<T>, done: (values: T[]) => void) => {
  const { items } = config;
  const [checked, setChecked] = useState<boolean[]>(items.map((i) => !!i.checked));
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<'idle' | 'done'>('idle');

  const cellWidth = Math.max(...items.map((i) => 8 + (i.icon ? visibleWidth(i.icon) + 1 : 0) + visibleWidth(i.label) + 2 + visibleWidth(i.tag ?? '')));
  const columns = config.columns ?? (terminalWidth() >= cellWidth * 2 + 8 ? 2 : 1);
  const rows = Math.ceil(items.length / columns);

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setStatus('done');
      done(items.filter((_, i) => checked[i]).map((i) => i.value));
      return;
    }
    if (isSpaceKey(key)) {
      setChecked(checked.map((c, i) => (i === active ? !c : c)));
      return;
    }
    // 竖向按列排：第一列是前半部分
    const col = Math.floor(active / rows);
    const row = active % rows;
    if (isUpKey(key) && row > 0) setActive(active - 1);
    else if (isDownKey(key) && row < rows - 1 && active + 1 < items.length) setActive(active + 1);
    else if (key.name === 'left' && col > 0) setActive(active - rows);
    else if (key.name === 'right' && col < columns - 1) setActive(Math.min(items.length - 1, active + rows));
    else if (key.name === 'a') setChecked(items.map((i) => !!i.preferred));
    else if (key.name === 'n') setChecked(items.map(() => false));
    else if (key.name === 'i') setChecked(checked.map((c) => !c));
  });

  const selectedValues = items.filter((_, i) => checked[i]).map((i) => i.value);
  if (status === 'done') {
    const names = items.filter((_, i) => checked[i]).map((i) => i.label).join(', ');
    return `${theme.success('✔')} ${theme.heading(config.message)} ${theme.brand(truncate(names, 60))}`;
  }

  const cell = (index: number): string => {
    const item = items[index];
    if (!item) return '';
    const box = checked[index] ? theme.brand('◼') : theme.subtle('◻');
    const isActive = index === active;
    const label = isActive ? chalk.bold.hex('#E8F6FF')(item.label) : item.preferred ? theme.value(item.label) : theme.subtle(item.label);
    const icon = item.icon ? `${item.icon} ` : '';
    const tag = item.tag ? `  ${theme.subtle(item.tag)}` : '';
    const text = `${isActive ? theme.brandBold('❯') : ' '} ${box} ${icon}${label}${tag}`;
    return isActive ? highlightRow(` ${text}`, cellWidth) : padVisible(` ${text}`, cellWidth);
  };

  const lines = [
    `${theme.brand('?')} ${theme.heading(config.message)}  ${theme.brand(t('ui_selected_count', { count: String(selectedValues.length) }))}`,
  ];
  for (let r = 0; r < rows; r++) {
    lines.push(Array.from({ length: columns }, (_, c) => cell(c * rows + r)).join('  ').replace(/\s+$/, ''));
  }
  const summary = config.summary?.(selectedValues);
  if (summary) lines.push('', `  ${summary}`);
  lines.push('', `  ${renderKeyHints(config.footer ?? [['space', t('ui_key_toggle')], ['a', t('ui_key_select_all')], ['n', t('ui_key_select_none')], ['i', t('ui_key_invert')], ['⏎', t('ui_key_confirm')]])}`);
  return `${lines.join('\n')}${CURSOR_HIDE}`;
});

// ─── 密钥输入：只显示首尾 4 位 ────────────────────────────────────

export interface SecretConfig {
  message: string;
  hint?: string;
  footer?: KeyHint[];
  // 允许 esc 取消（返回空字符串）
  escape?: boolean;
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${theme.subtle('•'.repeat(Math.min(value.length - 8, 24)))}${value.slice(-4)}`;
}

const secretView = createPrompt((config: SecretConfig, done: (value: string) => void) => {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'done'>('idle');

  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      setStatus('done');
      done(value.trim());
      return;
    }
    if (isEscape(key) && config.escape) {
      setStatus('done');
      done('');
      return;
    }
    if (isBackspaceKey(key) && !rl.line) {
      setValue('');
      return;
    }
    setValue(rl.line);
  });

  if (status === 'done') {
    return `${theme.success('✔')} ${theme.heading(config.message)} ${maskSecret(value)}`;
  }
  const count = value ? theme.subtle(`  ${t('ui_secret_length', { count: String(value.length) })}`) : '';
  const lines = [
    `${theme.brand('?')} ${theme.heading(config.message)}`,
    `  ${theme.brandBold('❯')} ${maskSecret(value)}${chalk.bgHex('#19C2F0')(' ')}${count}`,
  ];
  if (config.hint) lines.push(`  ${theme.subtle(config.hint)}`);
  if (config.footer?.length) lines.push('', `  ${renderKeyHints(config.footer)}`);
  return `${lines.join('\n')}${CURSOR_HIDE}`;
});

// 对外的类型化入口（createPrompt 推导出的类型不能直接导出）
export function menuPrompt<T>(config: MenuConfig<T>, context?: { signal?: AbortSignal }): Promise<MenuResult<T>> {
  return menuView(config as MenuConfig<unknown>, context) as Promise<MenuResult<T>>;
}

export function checkPrompt<T>(config: CheckConfig<T>): Promise<T[]> {
  return checkView(config as CheckConfig<unknown>) as Promise<T[]>;
}

export function secretPrompt(config: SecretConfig): Promise<string> {
  return secretView(config) as Promise<string>;
}
