import assert from 'node:assert/strict';
import test from 'node:test';

import { getModelCapabilities } from '../dist/lib/market-model-service.js';

test('getModelCapabilities tolerates features: null (international image models)', () => {
  // 回归：海外线路 openai/gpt-image-2.5-* 返回 features: null，选择模型时曾抛
  // "Cannot read properties of null (reading 'includes')"
  const caps = getModelCapabilities({
    id: 'openai/gpt-image-2.5-flare',
    features: null,
    model_constraints: { context_length: 0, max_tokens: 0 },
    architecture: {
      input_modalities: ['text', 'image'],
      function_calling: { supported: false },
      reasoning: { supported: false },
    },
  });
  assert.deepEqual(caps, {
    toolCall: false,
    images: true,
    reasoning: false,
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  });
});

test('getModelCapabilities tolerates missing architecture and constraints', () => {
  const caps = getModelCapabilities({ id: 'x', features: ['工具调用'] });
  assert.equal(caps.toolCall, true);
  assert.equal(caps.images, false);
  assert.equal(caps.reasoning, false);
  assert.equal(caps.maxInputTokens, 200000);
});
