import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'model-slots-'));
const { configManager } = await import('../dist/lib/config.js');
const { slotModel, slotOverrides } = await import('../dist/lib/core/model-slots.js');
test.after(() => fs.rmSync(process.env.HOME, { recursive: true, force: true }));
test('slot overrides survive main-model changes and only empty the selected tool', () => {
 assert.equal(slotModel('codex', 'review', 'main'), 'main');
 configManager.setModels({ slotModels: { codex: { review: 'review' }, grok: { summary: 'summary' } } });
 configManager.setModels({ codexModel: 'main2' }); assert.equal(slotModel('codex', 'review', 'main2'), 'review'); assert.equal(slotModel('codex', 'memory', 'main2'), 'main2');
 const snapshot = configManager.getModels(); snapshot.slotModels.codex.review = 'mutated'; assert.equal(slotModel('codex', 'review', 'main2'), 'review');
 configManager.setModels({ slotModels: { codex: {} } }); assert.deepEqual(slotOverrides('codex'), {}); assert.equal(slotModel('grok', 'summary', 'main'), 'summary');
});
