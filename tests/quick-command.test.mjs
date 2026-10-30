import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const homes = [];
const server = http.createServer(async (req, res) => {
  const region = req.url.split('/')[1];
  const route = req.url.split('?')[0].replace(/^\/(cn|intl)/, '');
  const key = req.headers.authorization?.replace('Bearer ', '');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const valid = region === 'intl' ? key === 'sk-intl' : ['sk-cn','sk-billing'].includes(key);
  if (!valid) return send(401, { error: { code: 'invalid_key' } });
  if (route === '/v2/stat/usage') return send(200, {});
  if (route === '/v1/models') return send(200, { data: [{ id: 'vendor/chat' }, { id: 'vendor/vision' }] });
  if (route === '/v1/market/models') return send(200, { status: true, data: ['vendor/chat','vendor/vision'].map(id => ({
    id, features: id.endsWith('chat') ? ['工具调用'] : [], architecture: { input_modalities: ['text'], function_calling: { supported: false }, reasoning: { supported: false } }, model_constraints: { context_length: 128000, max_tokens: 8192 },
  })) });
  if (route === '/v1/chat/completions') return key === 'sk-billing' ? send(403, { error: { code: 'account_billing_suspended' } }) : send(200, { choices: [] });
  if (route === '/bypass/openai/v1/responses') {
    let body = ''; for await (const chunk of req) body += chunk;
    const model = JSON.parse(body).model;
    assert.equal(JSON.parse(body).max_output_tokens, 16);
    if (!model.startsWith('openai/gpt')) return send(400, {});
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end('data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n');
  }
  send(404, {});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); });
export async function runQuick(args, extraEnv = {}, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-command-')); homes.push(home);
  fs.mkdirSync(path.join(home, '.coding-helper'));
  const helper = path.join(home, '.coding-helper/config.yaml');
  const before = 'lang: en_US\nendpoint: china\napi_key: old-key\n';
  fs.writeFileSync(helper, before);
  if (seed) seed(home);
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '/usr/bin:/bin',
    CODING_HELPER_BASE_URL_CHINA: `${base}/cn`, CODING_HELPER_BASE_URL_INTERNATIONAL: `${base}/intl`, ...extraEnv };
  try {
    const result = await execute(process.execPath, [path.resolve('dist/cli.js'), ...args], { env, timeout: 15000 });
    return { ...result, code: 0, home, helper, before };
  } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code, home, helper, before }; }
}
test('quick CLI configures a single tool and commits helper settings after success', async () => {
  const result = await runQuick(['opencode', 'sk-cn', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.model, 'vendor/chat');
  assert.equal(output.keySource, 'argument');
  assert.equal(output.results[0].status, 'success');
  const config = JSON.parse(fs.readFileSync(path.join(result.home, '.config/opencode/opencode.json'), 'utf8'));
  assert.equal(config.provider.qiniu.options.apiKey, 'sk-cn');
  assert.match(fs.readFileSync(result.helper, 'utf8'), /api_key: sk-cn/);
  assert.equal(result.stdout.includes('sk-cn'), false);
});
test('rejected key, model or account never changes helper settings or client files', async () => {
  for (const args of [['opencode','sk-invalid'], ['opencode','sk-cn','missing-model'], ['opencode','sk-cn','vendor/vision'], ['opencode','sk-billing']]) {
    const result = await runQuick([...args, '--json']);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(fs.readFileSync(result.helper, 'utf8'), result.before);
    assert.equal(fs.existsSync(path.join(result.home, '.config')), false);
  }
});
test('endpoint fallback, environment key and omitted vendor prefix work through the CLI', async () => {
  const result = await runQuick(['opencode','sk-intl','chat','--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).endpoint, 'international');
  assert.equal(JSON.parse(result.stdout).model, 'vendor/chat');
  const env = await runQuick(['opencode','--json'], { QINIU_API_KEY: 'sk-cn' });
  assert.equal(env.code, 0, env.stdout);
  assert.equal(JSON.parse(env.stdout).keySource, 'env');
});
test('Codex probes its default Responses model and rejects incompatible explicit models', async () => {
  const success = await runQuick(['codex','sk-cn','--json']);
  assert.equal(success.code, 0, success.stdout + success.stderr);
  assert.match(JSON.parse(success.stdout).model, /^openai\/gpt/);
  const failure = await runQuick(['codex','sk-cn','vendor/chat','--json']);
  assert.equal(failure.code, 1);
  assert.equal(fs.readFileSync(failure.helper, 'utf8'), failure.before);
  assert.equal(fs.existsSync(path.join(failure.home, '.codex')), false);
});
test('Responses probe rejects untyped, failed or incomplete streams', async () => {
  const { isCodexCompatibleStream } = await import('../dist/lib/tools/codex-tool.js');
  assert.equal(isCodexCompatibleStream('data: {"type":"response.completed"}\n\n'), true);
  assert.equal(isCodexCompatibleStream('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n'), true);
  for (const text of ['data: {}\n\n','data: {"type":"response.created"}\n\n', 'data: {"type":"response.failed"}\n\n']) assert.equal(isCodexCompatibleStream(text), false);
});
