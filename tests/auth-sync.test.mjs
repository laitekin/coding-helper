import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
const home = fs.mkdtempSync(os.tmpdir() + '/auth-sync-');
process.env.HOME = process.env.USERPROFILE = home;
const { configManager } = await import('../dist/lib/config.js');
const { toolManager } = await import('../dist/lib/tool-manager.js');
const { getSyncTargets } = await import('../dist/lib/core/tool-service.js');
const { authCommand } = await import('../dist/commands/auth.js');
const { uiRenderer } = await import('../dist/lib/wizard/ui/ui-renderer.js');
const oldFetch = globalThis.fetch, oldExit = process.exitCode;
const originals = Object.fromEntries(['renderSuccess','renderError','renderHint'].map(name => [name, uiRenderer[name]]));
for (const name of Object.keys(originals)) uiRenderer[name] = () => {};
globalThis.fetch = async () => new Response('{}');
test.after(() => { globalThis.fetch = oldFetch; process.exitCode = oldExit; Object.assign(uiRenderer, originals); fs.rmSync(home, { recursive: true, force: true }); });
test('sync excludes launch-only, foreign and unreadable configurations', () => {
  const tools = [{ name: 'qiniu', isConfigured: () => true }, { name: 'foreign', isConfigured: () => false },
    { name: 'broken', isConfigured() { throw Error('broken'); } }, { name: 'launcher', launchOnly: true, isConfigured: () => true }];
  assert.deepEqual(getSyncTargets(tools).map(tool => tool.name), ['qiniu']);
});
test('auth sync propagates partial failure and retries even when the key is unchanged', async () => {
  let succeeded = 0, fail = true;
  toolManager.register({ name: 'sync-ok', isConfigured: () => true, async loadConfig(key) { assert.equal(key, 'sk-new'); succeeded++; } });
  toolManager.register({ name: 'sync-fail', isConfigured: () => true, async loadConfig() { if (fail) throw Error('write failed'); } });
  toolManager.register({ name: 'sync-foreign', isConfigured: () => false, loadConfig() { assert.fail(); } });
  await authCommand('sk-new', { sync: true });
  assert.equal(process.exitCode, 2);
  assert.equal(configManager.getApiKey(), 'sk-new');
  fail = false;
  await authCommand('sk-new', { sync: true });
  assert.equal(process.exitCode, 0);
  assert.equal(succeeded, 2);
});
