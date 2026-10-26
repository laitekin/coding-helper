import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodexConfig,
  buildCodexAuthJson,
  buildCodexModelCatalog,
  mergeCodexConfig,
  restoreCodexConfig,
  getTopLevelTomlValue,
  removeManagedCodexConfig,
} from '../dist/lib/tools/codex-tool.js';

test('buildCodexModelCatalog contains only GPT models with Codex metadata', () => {
  const catalog = JSON.parse(buildCodexModelCatalog([
    { id: 'openai/gpt-5.4', context_length: 1050000, max_tokens: 128000 },
    { id: 'x-ai/grok-4.6', context_length: 500000, max_tokens: 128000 },
    { id: 'anthropic/claude-sonnet', context_length: 200000, max_tokens: 64000 },
  ]));

  assert.deepEqual(catalog.models.map((model) => model.slug), ['openai/gpt-5.4']);
  assert.equal(catalog.models[0].context_window, 1050000);
  assert.equal(catalog.models[0].max_context_window, 1050000);
  assert.equal(catalog.models[0].truncation_policy.limit, 10000);
  assert.equal(catalog.models[0].support_verbosity, false);
});

test('buildCodexConfig replaces existing TOML to avoid configuration conflicts', () => {
  const existing = [
    'approval_policy = "on-request"',
    'model_provider = "old"',
    '',
    '[model_providers.other]',
    'name = "Other"',
    '',
    '[model_providers.qnaigc]',
    'name = "Old"',
    'base_url = "https://old.example/v1"',
    '',
    '[profiles.qn-gpt]',
    'model_provider = "old"',
    'model = "old-model"',
    '',
    '[profiles.keep]',
    'model_provider = "other"',
    'model = "keep-model"',
    '',
  ].join('\n');

  const next = buildCodexConfig(existing, 'https://api.qnaigc.com', 'openai/gpt-5.2', '/tmp/qnaigc.json');

  assert.doesNotMatch(next, /approval_policy = "on-request"/);
  assert.match(next, /model_provider = "qnaigc"/);
  assert.match(next, /^model = "openai\/gpt-5\.2"\nmodel_provider = "qnaigc"/m);
  assert.doesNotMatch(next, /\[model_providers\.other\]/);
  assert.match(next, /\[model_providers\.qnaigc\]\nname = "Qiniu"\nbase_url = "https:\/\/api\.qnaigc\.com\/bypass\/openai\/v1"/);
  assert.match(next, /requires_openai_auth = true/);
  assert.match(next, /model_catalog_json = "\/tmp\/qnaigc\.json"/);
  assert.doesNotMatch(next, /env_key = "QINIU_API_KEY"/);
  assert.match(next, /\[profiles\.qn-gpt\]\nmodel_provider = "qnaigc"\nmodel = "openai\/gpt-5\.2"/);
  assert.doesNotMatch(next, /\[profiles\.keep\]/);
  assert.doesNotMatch(next, /https:\/\/old\.example/);
  assert.doesNotMatch(next, /model = "old-model"/);
});

test('removeManagedCodexConfig removes the managed catalog path', () => {
  const next = removeManagedCodexConfig('model_catalog_json = "/home/user/.codex/model-catalogs/qnaigc.json"\nmodel_provider = "qnaigc"\n');
  assert.doesNotMatch(next, /model_catalog_json/);
});

test('removeManagedCodexConfig removes the managed top-level model', () => {
  const next = removeManagedCodexConfig('model = "openai/gpt-6-astra"\nmodel_provider = "qnaigc"\n[model_providers.qnaigc]\n');
  assert.doesNotMatch(next, /^model\s*=/m);
});

test('removeManagedCodexConfig preserves a user model without managed qnaigc config', () => {
  const next = removeManagedCodexConfig('model = "customer-model"\n[model_providers.other]\n');
  assert.match(next, /^model = "customer-model"/m);
});

test('removeManagedCodexConfig preserves a user-owned catalog path', () => {
  const next = removeManagedCodexConfig('model_catalog_json = "/tmp/custom-catalog.json"\nmodel_provider = "qnaigc"\n');
  assert.match(next, /model_catalog_json = "\/tmp\/custom-catalog\.json"/);
});

test('buildCodexConfig replaces a user-owned catalog path', () => {
  const next = buildCodexConfig(
    'model_catalog_json = "/tmp/custom-catalog.json"\n',
    'https://api.qnaigc.com',
    'openai/gpt-5.5',
    '/home/user/.codex/model-catalogs/qnaigc.json',
  );
  assert.equal((next.match(/model_catalog_json\s*=/g) || []).length, 1);
  assert.match(next, /model_catalog_json = "\/home\/user\/\.codex\/model-catalogs\/qnaigc\.json"/);
  assert.doesNotMatch(next, /custom-catalog/);
});

test('buildCodexConfig writes the managed catalog at top level', () => {
  const next = buildCodexConfig(
    '[profiles.keep]\nmodel = "keep"\n',
    'https://api.qnaigc.com',
    'openai/gpt-5.5',
    '/home/user/.codex/model-catalogs/qnaigc.json',
  );
  assert.match(next, /^model = "openai\/gpt-5\.5"\nmodel_provider = "qnaigc"\nmodel_catalog_json = "\/home\/user\/\.codex\/model-catalogs\/qnaigc\.json"/);
  assert.doesNotMatch(next, /profiles\.keep/);
});

test('removeManagedCodexConfig removes the managed catalog path with Windows separators', () => {
  const next = removeManagedCodexConfig('model_catalog_json = "C:\\\\Users\\\\user\\\\.codex\\\\model-catalogs\\\\qnaigc.json"\n');
  assert.doesNotMatch(next, /model_catalog_json/);
});

test('removeManagedCodexConfig removes only helper-managed Codex settings', () => {
  const content = [
    '[profiles.keep]',
    'model_provider = "qnaigc"',
    'model = "keep"',
    '',
    '[model_providers.qnaigc.auth]',
    'command = "old-token-command"',
    '',
    '[profiles.qn-gpt]',
    'model_provider = "qnaigc"',
    'model = "openai/gpt-5.2"',
    '',
  ].join('\n');
  const next = removeManagedCodexConfig(content);

  assert.match(next, /\[profiles\.keep\]\nmodel_provider = "qnaigc"\nmodel = "keep"/);
  assert.doesNotMatch(next, /\[model_providers\.qnaigc\]/);
  assert.doesNotMatch(next, /\[model_providers\.qnaigc\.auth\]/);
  assert.doesNotMatch(next, /\[profiles\.qn-gpt\]/);
});

test('buildCodexConfig removes stale qnaigc dotted subtables before writing provider', () => {
  const next = buildCodexConfig(
    [
      '[model_providers.qnaigc]',
      'name = "Old"',
      '',
      '[model_providers.qnaigc.auth]',
      'command = "old-token-command"',
      '',
    ].join('\n'),
    'https://api.qnaigc.com',
  );

  assert.match(next, /\[model_providers\.qnaigc\]/);
  assert.doesNotMatch(next, /\[model_providers\.qnaigc\.auth\]/);
  assert.doesNotMatch(next, /old-token-command/);
});

test('buildCodexAuthJson stores the API key in Codex API key auth mode and preserves unrelated fields', () => {
  const next = buildCodexAuthJson(
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { refresh_token: 'keep-refresh-token' },
      last_refresh: '2026-05-20T00:00:00Z',
    }),
    'qiniu-key',
  );

  assert.deepEqual(JSON.parse(next), {
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'qiniu-key',
    tokens: { refresh_token: 'keep-refresh-token' },
    last_refresh: '2026-05-20T00:00:00Z',
  });
});

const USER_CONFIG = [
  '# 用户自己的注释',
  'model = "gpt-5"',
  'approval_policy = "on-request"',
  '',
  '[model_providers.other]',
  'name = "Other"',
  '',
  '[mcp_servers.docs]',
  'command = "docs-mcp"',
  '',
  '[profiles.keep]',
  'model = "keep-model"',
  '',
].join('\n');

test('mergeCodexConfig keeps user content and adds the managed provider', () => {
  const next = mergeCodexConfig(USER_CONFIG, 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');

  assert.match(next, /# 用户自己的注释/);
  assert.match(next, /approval_policy = "on-request"/);
  assert.match(next, /\[model_providers\.other\]/);
  assert.match(next, /\[mcp_servers\.docs\]\ncommand = "docs-mcp"/);
  assert.match(next, /\[profiles\.keep\]/);
  assert.equal(getTopLevelTomlValue(next, 'model'), '"openai/gpt-5.5"');
  assert.equal(getTopLevelTomlValue(next, 'model_provider'), '"qnaigc"');
  assert.equal(getTopLevelTomlValue(next, 'model_catalog_json'), '"/home/user/.codex/model-catalogs/qnaigc.json"');
  assert.match(next, /\[model_providers\.qnaigc\]\nname = "Qiniu"/);
  assert.match(next, /\[profiles\.qn-gpt\]/);
});

test('mergeCodexConfig is idempotent', () => {
  const once = mergeCodexConfig(USER_CONFIG, 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  const twice = mergeCodexConfig(once, 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  assert.equal(twice, once);
});

test('mergeCodexConfig switches the managed base URL when the endpoint changes', () => {
  const china = mergeCodexConfig(USER_CONFIG, 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  const intl = mergeCodexConfig(china, 'https://api.modelink.ai', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  assert.match(intl, /base_url = "https:\/\/api\.modelink\.ai\/bypass\/openai\/v1"/);
  assert.doesNotMatch(intl, /api\.qnaigc\.com/);
  assert.equal((intl.match(/\[model_providers\.qnaigc\]/g) || []).length, 1);
});

test('restoreCodexConfig returns the original file after merge', () => {
  const priors = {
    'config.model': getTopLevelTomlValue(USER_CONFIG, 'model') ?? null,
    'config.model_provider': null,
    'config.model_catalog_json': null,
  };
  const merged = mergeCodexConfig(USER_CONFIG, 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  const restored = restoreCodexConfig(merged, priors);
  assert.equal(restored, USER_CONFIG);
});

test('restoreCodexConfig restores a user-owned provider and catalog', () => {
  const original = 'model_provider = "azure"\nmodel_catalog_json = "/tmp/custom.json"\n\n[model_providers.azure]\nname = "Azure"\n';
  const priors = {
    'config.model': null,
    'config.model_provider': '"azure"',
    'config.model_catalog_json': '"/tmp/custom.json"',
  };
  const merged = mergeCodexConfig(original, 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  assert.equal(getTopLevelTomlValue(merged, 'model_provider'), '"qnaigc"');
  const restored = restoreCodexConfig(merged, priors);
  assert.equal(getTopLevelTomlValue(restored, 'model_provider'), '"azure"');
  assert.equal(getTopLevelTomlValue(restored, 'model_catalog_json'), '"/tmp/custom.json"');
  assert.equal(getTopLevelTomlValue(restored, 'model'), undefined);
  assert.match(restored, /\[model_providers\.azure\]/);
  assert.doesNotMatch(restored, /qnaigc/);
});

test('mergeCodexConfig works on an empty file', () => {
  const next = mergeCodexConfig('', 'https://api.qnaigc.com', 'openai/gpt-5.5', '/home/user/.codex/model-catalogs/qnaigc.json');
  assert.match(next, /^model = "openai\/gpt-5\.5"\nmodel_provider = "qnaigc"\nmodel_catalog_json = "[^"]+"\n\n\[model_providers\.qnaigc\]/);
});
