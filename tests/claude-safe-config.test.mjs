import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-safe-'));
process.env.HOME = process.env.USERPROFILE = home;
const { ClaudeCodeTool } = await import('../dist/lib/tools/claude-code-tool.js');
const { stateStore } = await import('../dist/lib/core/state-store.js');
const tool = new ClaudeCodeTool();
const settings = path.join(home, '.claude', 'settings.json');
const onboarding = path.join(home, '.claude.json');
const models = { claudeCode: { sonnetModel: 'test/sonnet', haikuModel: 'test/haiku', opusModel: 'test/opus' } };
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const read = file => fs.readFileSync(file, 'utf8');
function reset(a, b) {
  stateStore.clear();
  fs.rmSync(path.dirname(settings), { recursive: true, force: true }); fs.rmSync(onboarding, { force: true });
  if (a !== undefined) write(settings, a); if (b !== undefined) write(onboarding, b);
}
const load = (m = models) => tool.loadConfig('test-key', 'https://api.qnaigc.com', m);

test('Claude restores original bytes and nulls after load and reload', async () => {
  const original = '{\r\n "env": {"ANTHROPIC_AUTH_TOKEN":null,"USER_FLAG":"yes"}, "model":"custom/model", "attribution":null\r\n}\r\n';
  const other = '{ "hasCompletedOnboarding": false, "project": 1 }'; reset(original, other);
  await load(); await load();
  assert.equal(JSON.parse(read(settings)).model, undefined);
  assert.equal(JSON.parse(read(settings)).env.USER_FLAG, 'yes');
  tool.unloadConfig(); assert.equal(read(settings), original); assert.equal(read(onboarding), other);
  assert.equal(stateStore.getState(tool.name, settings), undefined); assert.equal(stateStore.getState(tool.name, onboarding), undefined);
});

test('Claude new files are removed and existing empty objects survive', async () => {
  reset(); await load(); tool.unloadConfig(); assert.equal(fs.existsSync(settings), false); assert.equal(fs.existsSync(onboarding), false);
  reset('{}', '{}'); await load(); tool.unloadConfig(); assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{}');
});

test('unload without a record preserves even Qiniu-owned-looking values', () => {
  const original = '{"env":{"ANTHROPIC_BASE_URL":"https://api.qnaigc.com","ANTHROPIC_AUTH_TOKEN":"user"}}';
  reset(original, '{}'); tool.unloadConfig(); assert.equal(read(settings), original);
});

for (const [a, b] of [['{broken','{}'], ['{}','{broken'], ['{"env":null}','{}'], ['{"env":[]}','{}']]) {
  test('invalid config causes no partial write: ' + a + ' / ' + b, async () => {
    reset(a, b); await assert.rejects(load()); assert.equal(read(settings), a); assert.equal(read(onboarding), b);
    assert.equal(stateStore.getState(tool.name, settings), undefined);
  });
}

test('switch clears /model and ANTHROPIC_MODEL, restores original including slash IDs', async () => {
  const original = '{"model":"original/model","env":{"ANTHROPIC_MODEL":"old/override"}}'; reset(original, '{}');
  await load(); let value = JSON.parse(read(settings)); assert.equal(value.model, undefined); assert.equal(value.env.ANTHROPIC_MODEL, undefined);
  value.model = 'picked/in-client'; write(settings, JSON.stringify(value));
  await load({ claudeCode: { sonnetModel: 'next/sonnet' } });
  value = JSON.parse(read(settings)); assert.equal(value.model, undefined); assert.equal(value.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  tool.unloadConfig(); assert.equal(read(settings), original);
});

test('default-model loads leave /model alone until an explicit model is selected', async () => {
  reset('{"model":"user/model"}', '{}'); await load({ claudeCode: { useDefaultModels: true } });
  assert.equal(JSON.parse(read(settings)).model, 'user/model');
  await load(); assert.equal(JSON.parse(read(settings)).model, undefined); tool.unloadConfig(); assert.equal(read(settings), '{"model":"user/model"}');
});

test('unload keeps user edits to managed and unrelated fields', async () => {
  reset('{"env":{"ANTHROPIC_AUTH_TOKEN":"original"},"model":"old/model"}', '{}'); await load();
  const value = JSON.parse(read(settings)); value.env.ANTHROPIC_AUTH_TOKEN = 'user-new'; value.env.USER_NEW = 'keep'; value.model = 'user/selection'; value.theme = 'dark';
  write(settings, JSON.stringify(value)); write(onboarding, '{"hasCompletedOnboarding":true,"added":1}');
  await assert.rejects(load(), /managed fields changed/);
  tool.unloadConfig(); const restored = JSON.parse(read(settings));
  assert.deepEqual(restored, { env: { ANTHROPIC_AUTH_TOKEN: 'user-new', USER_NEW: 'keep' }, model: 'user/selection', theme: 'dark' });
  assert.deepEqual(JSON.parse(read(onboarding)), { added: 1 });
});

test('second file write failure rolls back both first file and restoration records', async () => {
  reset('{ "env": {} }', '{ "keep": true }'); const rename = fs.renameSync; let injected = false;
  fs.renameSync = (from, to) => { if (to === onboarding && !injected) { injected = true; throw new Error('second write failed'); } return rename(from, to); };
  try { await assert.rejects(load(), /second write failed/); } finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.equal(read(settings), '{ "env": {} }'); assert.equal(read(onboarding), '{ "keep": true }');
  assert.equal(stateStore.getState(tool.name, settings), undefined); assert.equal(stateStore.getState(tool.name, onboarding), undefined);
  await load(); tool.unloadConfig(); assert.equal(read(settings), '{ "env": {} }');
});

test('failed unload rolls back both config and state and can be retried', async () => {
  reset('{}', '{}'); await load(); const beforeA = read(settings); const beforeB = read(onboarding); const remove = stateStore.markRemoved;
  stateStore.markRemoved = (name, file) => { if (file === onboarding) throw new Error('cleanup failed'); return remove.call(stateStore, name, file); };
  try { assert.throws(() => tool.unloadConfig(), /cleanup failed/); } finally { stateStore.markRemoved = remove; }
  assert.equal(read(settings), beforeA); assert.equal(read(onboarding), beforeB);
  assert.ok(stateStore.getState(tool.name, settings)); assert.ok(stateStore.getState(tool.name, onboarding));
  tool.unloadConfig(); assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{}');
});

test('second-file symlink blocks loading before settings changes', async () => {
  reset('{}'); const target = path.join(home, 'target.json'); write(target, '{}'); fs.symlinkSync(target, onboarding);
  await assert.rejects(load(), /symbolic link/); assert.equal(read(settings), '{}'); assert.equal(fs.lstatSync(onboarding).isSymbolicLink(), true);
});

test('unload validates both files before changing either and respects file deletion', async () => {
  reset('{}', '{}'); await load(); const a = read(settings); const b = read(onboarding); write(onboarding, '{broken');
  assert.throws(() => tool.unloadConfig(), /Cannot parse/); assert.equal(read(settings), a);
  write(onboarding, b); fs.rmSync(settings); tool.unloadConfig(); assert.equal(fs.existsSync(settings), false); assert.equal(read(onboarding), '{}');
});

test('inconsistent saved snapshots are rejected before touching either file', async () => {
  reset('{}', '{}'); await load(); const a = read(settings); const b = read(onboarding);
  const saved = stateStore.getState(tool.name, settings); saved.priors.snapshot.model = 'forged'; stateStore.setState(tool.name, saved, settings);
  assert.throws(() => tool.unloadConfig(), /inconsistent/); await assert.rejects(load(), /inconsistent/);
  assert.equal(read(settings), a); assert.equal(read(onboarding), b);
});

test('last-moment second-file edit survives while first-file write rolls back', async () => {
  reset('{}', '{"keep":1}'); const writeFile = fs.writeFileSync; let changed = false;
  fs.writeFileSync = (file, ...args) => {
    const result = writeFile(file, ...args);
    if (String(file).includes('.claude.json.tmp-') && !changed) { changed = true; writeFile(onboarding, '{"keep":2}'); }
    return result;
  };
  try { await assert.rejects(load(), /changed before writing/); } finally { fs.writeFileSync = writeFile; }
  assert.equal(changed, true); assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{"keep":2}');
  assert.equal(stateStore.getState(tool.name, settings), undefined);
});


for (const completed of [0, 1, 2]) {
  test('Claude reconciles interrupted reload after ' + completed + ' client writes', async () => {
    reset('{}', '{}'); await load();
    const files = [settings, onboarding]; const before = files.map(read);
    const previous = files.map(file => stateStore.getState(tool.name, file));
    await tool.loadConfig('next-key', 'https://api.qnaigc.com', models);
    const after = files.map(read); const next = files.map(file => stateStore.getState(tool.name, file));
    files.forEach((file, i) => {
      write(file, i < completed ? after[i] : before[i]);
      stateStore.setState(tool.name, { priors: next[i].priors, applied: previous[i].applied,
        pending: { before: before[i], after: after[i], applied: next[i].applied } }, file);
    });
    tool.unloadConfig(); assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{}');
  });
}

test('Claude post-rename failure rolls back both files and state', async () => {
  reset('{}', '{}'); const rename = fs.renameSync; let once = true;
  fs.renameSync = (from, to) => { const result = rename(from, to); if (to === onboarding && once) { once = false; throw Error('after rename'); } return result; };
  try { await assert.rejects(load(), /after rename/); } finally { fs.renameSync = rename; }
  assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{}');
  assert.equal(stateStore.getState(tool.name, settings), undefined);
});


test('unload cleanup plus rollback failure preserves all original records for retry', async () => {
  reset('{}', '{}'); await load(); const loaded = read(settings);
  const remove = stateStore.markRemoved; const rename = fs.renameSync; let cleanupFailed = false;
  stateStore.markRemoved = function (name, file) {
    if (file === onboarding) { cleanupFailed = true; throw Error('cleanup failure'); }
    return remove.call(this, name, file);
  };
  fs.renameSync = (from, to) => { if (cleanupFailed && to === settings) throw Error('rollback failure'); return rename(from, to); };
  try { assert.throws(() => tool.unloadConfig(), /recovery failed/); }
  finally { stateStore.markRemoved = remove; fs.renameSync = rename; }
  assert.ok(stateStore.getState(tool.name, settings)); assert.ok(stateStore.getState(tool.name, onboarding));
  tool.unloadConfig(); assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{}');
});


test('partial load rollback reconciles each successful rollback independently', async () => {
  reset('{}', '{}'); await load();
  write(onboarding, '{}'); stateStore.markRemoved(tool.name, onboarding);
  const set = stateStore.setState; const rename = fs.renameSync; let calls = 0; let finalFailed = false;
  stateStore.setState = function (...args) { if (++calls === 4) { finalFailed = true; throw Error('final commit failed'); } return set.apply(this, args); };
  fs.renameSync = (from, to) => { if (finalFailed && to === onboarding) throw Error('rollback failed'); return rename(from, to); };
  try { await assert.rejects(tool.loadConfig('next-key', 'https://api.qnaigc.com', models), /recovery failed/); }
  finally { stateStore.setState = set; fs.renameSync = rename; }
  tool.unloadConfig(); assert.equal(read(settings), '{}'); assert.equal(read(onboarding), '{}');
});
