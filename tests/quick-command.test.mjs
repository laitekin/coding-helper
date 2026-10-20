import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { parseQuickArgs, pickApiKey, pickModel, suggestModels } = await import('../dist/lib/core/quick-args.js');
const { modelConfigFor } = await import('../dist/lib/core/model-mapping.js');

// ---- 纯函数 ----

test('parseQuickArgs recognises key and model by content, in any order', () => {
  assert.deepEqual(parseQuickArgs('codex', ['sk-1', 'deepseek/x']), { tools: ['codex'], apiKey: 'sk-1', model: 'deepseek/x' });
  assert.deepEqual(parseQuickArgs('codex', ['deepseek/x', 'sk-1']), { tools: ['codex'], apiKey: 'sk-1', model: 'deepseek/x' });
  assert.deepEqual(parseQuickArgs('claude,codex', ['deepseek/x']), { tools: ['claude', 'codex'], model: 'deepseek/x' });
  assert.deepEqual(parseQuickArgs('all', []), { tools: 'all' });
  assert.throws(() => parseQuickArgs('codex', ['sk-1', 'sk-2']));
  assert.throws(() => parseQuickArgs('codex', ['a', 'b']));
});

test('pickApiKey prefers argument, then QINIU_API_KEY, then saved', () => {
  assert.deepEqual(pickApiKey({ tools: [], apiKey: 'sk-a' }, { QINIU_API_KEY: 'sk-e' }, 'sk-s'), { key: 'sk-a', source: 'argument' });
  assert.deepEqual(pickApiKey({ tools: [] }, { QINIU_API_KEY: 'sk-e' }, 'sk-s'), { key: 'sk-e', source: 'env' });
  assert.deepEqual(pickApiKey({ tools: [] }, {}, 'sk-s'), { key: 'sk-s', source: 'saved' });
  assert.equal(pickApiKey({ tools: [] }, {}, undefined), undefined);
});

test('pickModel: requested, missing prefix, saved, auto, and errors', () => {
  const available = ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'qwen-vl-max', 'z-ai/glm-5.2'];
  const capable = new Set(['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.2']);
  assert.deepEqual(pickModel('z-ai/glm-5.2', undefined, available, capable), { model: 'z-ai/glm-5.2', source: 'argument', corrected: undefined });
  assert.deepEqual(pickModel('deepseek-v4-pro', undefined, available, capable), { model: 'deepseek/deepseek-v4-pro', source: 'argument', corrected: 'deepseek-v4-pro' });
  assert.deepEqual(pickModel(undefined, 'z-ai/glm-5.2', available, capable), { model: 'z-ai/glm-5.2', source: 'saved' });
  assert.deepEqual(pickModel(undefined, 'gone/model', available, capable), { model: 'deepseek/deepseek-v4-flash', source: 'auto' });
  assert.equal(pickModel('qwen-vl-max', undefined, available, capable).error, 'no_tool_call');
  const missing = pickModel('deepseek-v9', undefined, available, capable);
  assert.equal(missing.error, 'not_available');
  assert.ok(missing.suggestions.includes('deepseek/deepseek-v4-pro'));
  assert.equal(pickModel(undefined, undefined, ['qwen-vl-max'], new Set(['other'])).error, 'none_available');
  // 能力数据不可用时不做工具调用检查
  assert.deepEqual(pickModel('qwen-vl-max', undefined, available, new Set()), { model: 'qwen-vl-max', source: 'argument', corrected: undefined });
});

test('suggestModels finds near matches', () => {
  assert.deepEqual(suggestModels('glm-5', ['z-ai/glm-5.2', 'deepseek/deepseek-v4-pro']), ['z-ai/glm-5.2']);
});

test('modelConfigFor maps one model onto each tool', () => {
  assert.deepEqual(modelConfigFor({ name: 'claude-code' }, 'm').claudeCode.opusModel, 'm');
  assert.deepEqual(modelConfigFor({ name: 'codex' }, 'm'), { codexModel: 'm' });
  assert.deepEqual(modelConfigFor({ name: 'codebuddy' }, 'm'), { codeBuddyModels: ['m'] });
  assert.deepEqual(modelConfigFor({ name: 'hermes' }, 'm'), { hermesModel: 'm' });
  assert.deepEqual(modelConfigFor({ name: 'grok' }, 'm'), { toolModels: { grok: 'm' } });
});

// ---- 端到端：本地模拟七牛接口，真实运行 CLI ----

// 与实测一致：GPT 模型不在 /v1/models 中，但能在 Responses 接口上使用
const MODELS = ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'qwen-vl-max', 'z-ai/glm-5.2', 'qwen/qwen3.7-plus'];
const VALID = { cn: new Set(['sk-good', 'sk-broke']), intl: new Set(['sk-intl']) };

function market(id) {
  const tools = id !== 'qwen-vl-max';
  return {
    id, name: id, description: '', features: tools ? ['工具调用'] : [],
    model_constraints: { context_length: 128000, max_tokens: 8192, max_completion_tokens: 0, max_default_completion_tokens: 0, max_chain_of_thought_length: 0 },
    architecture: {
      input_modalities: ['text'], output_modalities: ['text'], function_calling: { supported: tools },
      schema_output: { supported: false }, reasoning: { supported: false }, content_cache: { supported: false },
    },
    issuer: { name: '', avatar: '', model_page: '' },
  };
}

const server = http.createServer((req, res) => {
  const [, region, ...rest] = req.url.split('?')[0].split('/');
  const route = `/${rest.join('/')}`;
  const key = (req.headers.authorization || '').replace('Bearer ', '');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const known = VALID[region]?.has(key);
  if (route === '/v1/models') return send(200, { object: 'list', data: MODELS.map((id) => ({ id })) });
  if (!known) return send(401, { error: { message: 'Invalid API key', code: 'auth_api_key_invalid' } });
  if (route === '/v2/stat/usage') return send(200, { data: [] });
  if (route === '/v1/market/models') return send(200, { status: true, data: MODELS.map(market) });
  if (route === '/bypass/openai/v1/responses') {
    // 模拟：GPT 与 glm 返回标准流；qwen 在这里模拟一种事件缺少 type 的非标准流；其他模型 502
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { model } = JSON.parse(raw || '{}');
      if (model === 'z-ai/glm-5.2' || model.startsWith('openai/gpt')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n');
      } else if (model === 'qwen/qwen3.7-plus') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.created\ndata: {"response":{}}\n\nevent: response.completed\ndata: {"response":{}}\n\n');
      } else {
        send(502, { error: { message: 'no available channels' } });
      }
    });
    return;
  }
  if (route === '/v1/chat/completions') {
    if (key === 'sk-broke') return send(403, { error: { message: 'Account is suspended due to billing status', code: 'account_billing_suspended' } });
    return send(200, { choices: [{ message: { content: 'h' } }] });
  }
  send(404, {});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function run(args, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-quick-'));
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    CODING_HELPER_BASE_URL_CHINA: `${base}/cn`,
    CODING_HELPER_BASE_URL_INTERNATIONAL: `${base}/intl`,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [path.resolve('dist/cli.js'), ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr, home });
    });
  });
}

const opencodeFile = (home) => path.join(home, '.config', 'opencode', 'opencode.json');

test('one command configures a tool with an auto-selected model and saves the key', async () => {
  const r = await run(['opencode', 'sk-good', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.model, 'deepseek/deepseek-v4-flash');
  assert.equal(out.modelSource, 'auto');
  assert.equal(out.endpoint, 'china');
  assert.equal(out.results[0].status, 'success');
  const config = JSON.parse(fs.readFileSync(opencodeFile(r.home), 'utf-8'));
  assert.equal(config.model, 'qiniu/deepseek/deepseek-v4-flash');
  assert.equal(config.provider.qiniu.options.baseURL, `${base}/cn/v1`);
  assert.match(fs.readFileSync(path.join(r.home, '.coding-helper', 'config.yaml'), 'utf-8'), /api_key: sk-good/);
});

test('key valid only on the other endpoint switches automatically', async () => {
  const r = await run(['opencode', 'sk-intl', '--json']);
  assert.equal(r.code, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.endpoint, 'international');
  assert.equal(out.endpointSwitched, true);
});

test('billing-suspended account stops before writing anything', async () => {
  const r = await run(['opencode', 'sk-broke', '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout).error, /欠费|billing/);
  assert.equal(fs.existsSync(opencodeFile(r.home)), false);
});

test('invalid key, unknown model and non tool-calling model all stop with exit code 1', async () => {
  const bad = await run(['opencode', 'sk-nope', '--json']);
  assert.equal(bad.code, 1);
  const unknown = await run(['opencode', 'sk-good', 'deepseek-v9', '--json']);
  assert.equal(unknown.code, 1);
  assert.ok(JSON.parse(unknown.stdout).suggestions.includes('deepseek/deepseek-v4-pro'));
  const noTools = await run(['opencode', 'sk-good', 'qwen-vl-max', '--json']);
  assert.equal(noTools.code, 1);
  for (const r of [bad, unknown, noTools]) assert.equal(fs.existsSync(opencodeFile(r.home)), false);
});

test('Codex without a model falls back to its GPT default instead of being skipped', async () => {
  const r = await run(['codex', 'sk-good', '--json']);
  assert.equal(r.code, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.model, 'openai/gpt-6-astra');
  assert.equal(out.modelSource, 'tool_default');
  const mixed = JSON.parse((await run(['codex,opencode', 'sk-good', '--json'])).stdout);
  assert.deepEqual(mixed.toolModels, { codex: 'openai/gpt-6-astra', opencode: 'deepseek/deepseek-v4-flash' });
});

test('Codex accepts a non-GPT model only when its Responses stream is compatible', async () => {
  const glm = await run(['codex', 'sk-good', 'z-ai/glm-5.2', '--json']);
  assert.equal(glm.code, 0, glm.stdout);
  assert.match(fs.readFileSync(path.join(glm.home, '.codex', 'config.toml'), 'utf-8'), /model = "z-ai\/glm-5\.2"/);
  const qwen = await run(['codex', 'sk-good', 'qwen/qwen3.7-plus', '--json']);
  assert.equal(qwen.code, 1);
  assert.equal(JSON.parse(qwen.stdout).results[0].reason, 'quick_codex_model_unsupported');
  assert.equal(fs.existsSync(path.join(qwen.home, '.codex', 'config.toml')), false);
});

test('isCodexCompatibleStream requires typed events ending in response.completed', async () => {
  const { isCodexCompatibleStream } = await import('../dist/lib/tools/codex-tool.js');
  assert.equal(isCodexCompatibleStream('data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n'), true);
  assert.equal(isCodexCompatibleStream('data: {"response":{}}\n\ndata: {"type":"response.completed"}\n'), false);
  assert.equal(isCodexCompatibleStream('data: {"type":"response.created"}\n'), false);
  assert.equal(isCodexCompatibleStream(''), false);
});

test('Codex rejects an incompatible non-GPT model; other tools in the same command still succeed', async () => {
  const gpt = await run(['codex', 'sk-good', 'openai/gpt-6-astra', '--json']);
  assert.equal(gpt.code, 0, gpt.stdout);
  assert.match(fs.readFileSync(path.join(gpt.home, '.codex', 'config.toml'), 'utf-8'), /model = "openai\/gpt-6-astra"/);

  const mixed = await run(['codex,opencode', 'sk-good', 'deepseek-v4-pro', '--json']);
  const out = JSON.parse(mixed.stdout);
  assert.equal(out.model, 'deepseek/deepseek-v4-pro');
  assert.deepEqual(out.results.map((x) => [x.tool, x.status]).sort(), [['codex', 'skipped'], ['opencode', 'success']]);
  assert.equal(mixed.code, 0);
  assert.equal(fs.existsSync(path.join(mixed.home, '.codex', 'config.toml')), false);
});

test('--dry-run writes nothing and never prints the full key', async () => {
  const r = await run(['opencode', 'sk-good', '--dry-run', '--json']);
  assert.equal(r.code, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.ok(out.changes.some((c) => c.file.endsWith('opencode.json')));
  assert.ok(!r.stdout.includes('sk-good'));
  assert.equal(fs.existsSync(opencodeFile(r.home)), false);
  assert.equal(fs.existsSync(path.join(r.home, '.coding-helper', 'config.yaml')), false);
});

test('--no-save writes the tool config but not config.yaml; QINIU_API_KEY is used', async () => {
  const r = await run(['grok', '--no-save', '--json'], { QINIU_API_KEY: 'sk-good' });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).keySource, 'env');
  assert.ok(fs.existsSync(path.join(r.home, '.grok', 'config.toml')));
  assert.equal(fs.existsSync(path.join(r.home, '.coding-helper', 'config.yaml')), false);
});

test('human output is short and ends with how to start and undo', async () => {
  const r = await run(['opencode', 'sk-good']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const text = r.stdout + r.stderr;
  assert.match(text, /opencode/);
  assert.match(text, /restore opencode/);
  assert.ok(!text.includes('sk-good'));
});

test('unknown first argument is reported with the list of tools', async () => {
  const r = await run(['nosuchtool']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /claude, codex/);
});
