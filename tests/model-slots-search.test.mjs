import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-slots-'));

const { configManager } = await import('../dist/lib/config.js');
const { scoreModel, closestModels, resolveModelId, parseModelQuery, vendorOf } = await import('../dist/lib/core/model-search.js');
const { slotModel, slotOverrides } = await import('../dist/lib/core/model-slots.js');
const { modelConfigFor } = await import('../dist/lib/core/model-mapping.js');
const { applyCodexSlots, captureCodexSlotPriors, restoreCodexConfig } = await import('../dist/lib/tools/codex-tool.js');
const { applyDroidSettings, revertDroidSettings, captureDroidPriors, droidCustomModelId } = await import('../dist/lib/tools/droid-tool.js');
const { applyGrokConfig, revertGrokConfig } = await import('../dist/lib/tools/grok-tool.js');
const { applyHermesVision, captureHermesVisionPriors } = await import('../dist/lib/tools/hermes-tool.js');
const { highlightMatch } = await import('../dist/lib/wizard/ui/prompts.js');

const IDS = ['deepseek/deepseek-v4-flash', 'qwen/qwen3.7-plus', 'z-ai/glm-5.2', 'moonshotai/kimi-k3', 'minimax/minimax-m3', 'openai/gpt-5.4'];
const model = (id, context = 200000, vision = false) => ({ id, context, toolCall: true, vision });
const matches = (q, models = IDS.map((id) => model(id))) => models
  .map((m) => ({ id: m.id, score: scoreModel(m, q) }))
  .filter((x) => x.score !== undefined)
  .sort((a, b) => a.score - b.score)
  .map((x) => x.id);

// ---- 模型搜索 ----

test('search ignores - / . and spaces', () => {
  assert.deepEqual(matches('glm5'), ['z-ai/glm-5.2']);
  assert.deepEqual(matches('k3'), ['moonshotai/kimi-k3']);
  assert.deepEqual(matches('v4flash'), ['deepseek/deepseek-v4-flash']);
  assert.deepEqual(matches('glm 5.2'), ['z-ai/glm-5.2']);
});

test('search understands Chinese vendor names', () => {
  assert.deepEqual(matches('智谱'), ['z-ai/glm-5.2']);
  assert.deepEqual(matches('千问'), ['qwen/qwen3.7-plus']);
  assert.deepEqual(matches('月之暗面'), ['moonshotai/kimi-k3']);
  assert.deepEqual(matches('深度求索'), ['deepseek/deepseek-v4-flash']);
  assert.equal(vendorOf('z-ai/glm-5.2'), 'glm');
});

test('search filters by context size and vision', () => {
  const list = [model('a/small', 128000), model('a/big', 1000000), model('a/eye', 256000, true)];
  assert.deepEqual(matches('200k', list).sort(), ['a/big', 'a/eye']);
  assert.deepEqual(matches('1m', list), ['a/big']);
  assert.deepEqual(matches('看图', list), ['a/eye']);
  assert.deepEqual(matches('vision 1m', list), []);
  assert.deepEqual(parseModelQuery('glm 200k 看图'), { words: ['glm'], minContext: 200000, vision: true });
});

test('ranking: prefix match, then recommended, then recently used', () => {
  const prefix = scoreModel(model('x/qwen-max'), 'qwen');
  const inside = scoreModel(model('x/coder-qwen'), 'qwen', { recommended: true, recent: true });
  assert.ok(prefix < inside);
  const rec = scoreModel(model('x/qwen-a'), 'qwen', { recommended: true });
  const recent = scoreModel(model('x/qwen-b'), 'qwen', { recent: true });
  const plain = scoreModel(model('x/qwen-c'), 'qwen');
  assert.ok(rec < recent && recent < plain);
});

test('no match: closest models and vendor prefix completion', () => {
  assert.equal(matches('glm9x').length, 0);
  assert.equal(closestModels(IDS, 'glm9')[0], 'z-ai/glm-5.2');
  assert.equal(closestModels(IDS, 'xyz').length, 3);
  assert.equal(resolveModelId('glm-5.2', IDS), 'z-ai/glm-5.2');
  assert.equal(resolveModelId('kimi-k3', IDS), 'moonshotai/kimi-k3');
  assert.equal(resolveModelId('my/own', IDS), 'my/own');
  assert.equal(resolveModelId('unknown-1', IDS), 'unknown-1');
});

test('highlightMatch underlines the matched characters only', () => {
  const strip = (s) => s.replace(/\x1B\[[0-9;]*m/g, '');
  assert.equal(strip(highlightMatch('z-ai/glm-5.2', 'glm5')), 'z-ai/glm-5.2');
  assert.equal(highlightMatch('z-ai/glm-5.2', 'qq'), 'z-ai/glm-5.2');
});

// ---- 槽位：默认跟随主模型 ----

test('slots follow the main model unless set separately', () => {
  assert.equal(slotModel('codex', 'review', 'm1'), 'm1');
  configManager.setModels({ slotModels: { codex: { review: 'r1' } } });
  assert.equal(slotModel('codex', 'review', 'm1'), 'r1');
  assert.equal(slotModel('codex', 'subagent', 'm1'), 'm1');
  configManager.setModels({ slotModels: { codex: {} } });
  assert.deepEqual(slotOverrides('codex'), {});
  assert.equal(configManager.getModels().slotModels, undefined);
});

test('Claude Code: fallback and subagent follow main unless set', () => {
  const follow = modelConfigFor({ name: 'claude-code' }, 'glm', { slotModels: {} });
  assert.deepEqual(follow.claudeCode, { haikuModel: 'glm', sonnetModel: 'glm', opusModel: 'glm', subagentModel: 'glm', useDefaultModels: false });
  const own = modelConfigFor({ name: 'claude-code' }, 'glm', { slotModels: { 'claude-code': { fallback: 'fast' } } });
  assert.equal(own.claudeCode.haikuModel, 'fast');
  assert.equal(own.claudeCode.sonnetModel, 'glm');
});

test('recent models keep the latest three', () => {
  for (const m of ['a', 'b', 'c', 'a', 'd']) configManager.rememberModel(m);
  assert.deepEqual(configManager.getModels().recentModels, ['d', 'a', 'c']);
});

// ---- 各工具的槽位写入与还原 ----

test('Codex: review / subagent / memory slots are written and restored', () => {
  const before = 'model = "gpt-5"\nreview_model = "gpt-5.1-codex-max"\n\n[mcp_servers.x]\ncommand = "x"\n';
  const priors = captureCodexSlotPriors(before);
  const written = applyCodexSlots(before, { review: 'z-ai/glm-5.2', subagent: 'z-ai/glm-5.2', memory: 'qwen/qwen3.7-plus' });
  assert.match(written, /^review_model = "z-ai\/glm-5.2"$/m);
  assert.match(written, /\[agents\]\ndefault_subagent_model = "z-ai\/glm-5.2"/);
  assert.match(written, /\[memories\]\nextract_model = "qwen\/qwen3.7-plus"\nconsolidation_model = "qwen\/qwen3.7-plus"/);
  assert.match(written, /\[mcp_servers.x\]/);
  const restored = restoreCodexConfig(written, { ...priors, 'config.model': '"gpt-5"' });
  assert.match(restored, /^review_model = "gpt-5.1-codex-max"$/m);
  assert.doesNotMatch(restored, /\[agents\]|\[memories\]/);
  assert.match(restored, /\[mcp_servers.x\]/);
});

test('Factory Droid: session default model points at the Qiniu custom model', () => {
  const settings = { customModels: [{ model: 'mine', displayName: 'Mine', baseUrl: 'http://x' }], sessionDefaultSettings: { model: 'claude-opus-4-5', autonomyMode: 'auto-low' } };
  const priors = captureDroidPriors(settings);
  const next = applyDroidSettings(settings, 'https://api.qnaigc.com', 'sk-x', 'z-ai/glm-5.2');
  assert.equal(droidCustomModelId('Qiniu: z-ai/glm-5.2'), 'custom:Qiniu:-z-ai/glm-5.2-0');
  assert.equal(next.sessionDefaultSettings.model, 'custom:Qiniu:-z-ai/glm-5.2-0');
  assert.equal(next.sessionDefaultSettings.specModeModel, 'custom:Qiniu:-z-ai/glm-5.2-0');
  assert.equal(next.sessionDefaultSettings.autonomyMode, 'auto-low');
  assert.equal(next.customModels.length, 2);

  const spec = applyDroidSettings(settings, 'https://api.qnaigc.com', 'sk-x', 'z-ai/glm-5.2', undefined, 'qwen/qwen3.7-plus');
  assert.equal(spec.customModels.length, 3);
  assert.equal(spec.sessionDefaultSettings.specModeModel, 'custom:Qiniu:-qwen/qwen3.7-plus-0');

  const reverted = revertDroidSettings(spec, priors);
  assert.deepEqual(reverted, { customModels: [settings.customModels[0]], sessionDefaultSettings: { model: 'claude-opus-4-5', autonomyMode: 'auto-low' } });
  // 再次装载时，七牛写入的值不会被当成原值
  assert.equal(captureDroidPriors(next)['sessionDefaultSettings.model'], null);
});

test('Grok: session summary uses the Qiniu model, or its own entry when set', () => {
  const base = '[ui]\ntheme = "dark"\n';
  const same = applyGrokConfig(base, 'https://api.qnaigc.com', 'sk-x', 'z-ai/glm-5.2', 200000);
  assert.match(same, /\[models\]\ndefault = "qiniu"\nsession_summary = "qiniu"/);
  assert.doesNotMatch(same, /qiniu-summary/);
  const own = applyGrokConfig(base, 'https://api.qnaigc.com', 'sk-x', 'z-ai/glm-5.2', 200000, { model: 'qwen/qwen3.7-plus' });
  assert.match(own, /session_summary = "qiniu-summary"/);
  assert.match(own, /\[model.qiniu-summary\]\nmodel = "qwen\/qwen3.7-plus"/);
  const reverted = revertGrokConfig(own, { 'models.default': null, 'models.session_summary': null });
  assert.equal(reverted.trim(), '[ui]\ntheme = "dark"');
});

test('Hermes: vision slot is written only when set, and restored', () => {
  const base = 'model:\n  default: m\n# keep\nauxiliary:\n  vision:\n    provider: auto\n';
  const priors = captureHermesVisionPriors(base);
  assert.equal(applyHermesVision(base, undefined, priors), base);
  const set = applyHermesVision(base, { model: 'qwen-vl', baseUrl: 'https://api.qnaigc.com', apiKey: 'sk-x' }, priors);
  assert.match(set, /provider: custom/);
  assert.match(set, /model: qwen-vl/);
  assert.match(set, /base_url: https:\/\/api.qnaigc.com\/v1/);
  assert.match(set, /# keep/);
  const back = applyHermesVision(set, undefined, priors);
  assert.match(back, /provider: auto/);
  assert.doesNotMatch(back, /qwen-vl|api_key/);
});
