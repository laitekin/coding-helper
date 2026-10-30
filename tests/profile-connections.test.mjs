import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-connections-'));
const { configManager } = await import('../dist/lib/config.js');
const { applyTool } = await import('../dist/lib/core/tool-service.js');
test.after(() => fs.rmSync(process.env.HOME, { recursive: true, force: true }));
test('profile selection, bindings and explicit connections resolve consistently', async () => {
 configManager.saveProfile('work', 'sk-work', 'china'); configManager.saveProfile('home', 'sk-home', 'custom', 'https://gateway.example/proxy');
 configManager.useProfile('work'); configManager.setToolProfile('demo', 'home');
 assert.equal(configManager.getConnection('demo').apiKey, 'sk-home');
 configManager.setApiKey('sk-work-new'); assert.equal(configManager.getProfile('work').apiKey, 'sk-work-new');
 let received; const tool = { name: 'demo', loadConfig: async (...args) => { received = args; } };
 assert.equal((await applyTool(tool)).status, 'success'); assert.equal(received[0], 'sk-home'); assert.equal(received[1], 'https://gateway.example/proxy');
 await applyTool(tool, { apiKey: 'explicit', baseUrl: 'https://explicit.example' }); assert.equal(received[0], 'explicit'); assert.equal(received[1], 'https://explicit.example');
 assert.throws(() => configManager.setToolProfile('demo', 'missing'));
 assert.throws(() => configManager.saveProfile('__proto__', 'bad', 'china'));
 configManager.removeProfile('home'); assert.equal(configManager.getToolProfile('demo'), undefined);
 configManager.reload(); assert.equal(configManager.getActiveProfile(), 'work');
});
