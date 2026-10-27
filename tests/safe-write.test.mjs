import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 隔离 HOME：所有读写都落在临时目录
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-safe-write-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { stateStore } = await import('../dist/lib/core/state-store.js');
const { readJsonObjectStrict, safeWriteFile, backupsRoot, formatJsonLike } = await import('../dist/lib/core/safe-write.js');

test('safeWriteFile backs up the original under ~/.coding-helper/backups', () => {
  const file = path.join(home, 'some-config.json');
  fs.writeFileSync(file, 'before\n');
  safeWriteFile(file, 'after\n');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'after\n');
  assert.equal(backupsRoot(), path.join(home, '.coding-helper', 'backups'));
  const [session] = fs.readdirSync(backupsRoot());
  const manifest = JSON.parse(fs.readFileSync(path.join(backupsRoot(), session, 'manifest.json'), 'utf-8'));
  const entry = manifest.files.find((item) => item.source === file);
  assert.ok(entry);
  assert.equal(fs.readFileSync(entry.backup, 'utf-8'), 'before\n');
  // 同一次运行内同一文件只备份一次，备份保留最初的内容
  safeWriteFile(file, 'again\n');
  assert.equal(fs.readFileSync(entry.backup, 'utf-8'), 'before\n');
});

test('readJsonObjectStrict throws on invalid JSON instead of returning an empty object', () => {
  const file = path.join(home, 'broken.json');
  fs.writeFileSync(file, '{ "a": 1,, }');
  assert.throws(() => readJsonObjectStrict(file));
  assert.deepEqual(readJsonObjectStrict(path.join(home, 'missing.json')), {});
});

test('JSON is written in the style of the original file', () => {
  assert.equal(formatJsonLike('{"a":1}\n', { a: 1, b: 2 }), '{"a":1,"b":2}\n');
  assert.equal(formatJsonLike('{\n    "a": 1\n}', { a: 1 }), '{\n    "a": 1\n}');
  assert.equal(formatJsonLike('{\n\t"a": 1\n}\n', { a: 1 }), '{\n\t"a": 1\n}\n');
  assert.equal(formatJsonLike(undefined, { a: 1 }), '{\n  "a": 1\n}\n');
});

test('stateStore keeps the first recorded prior values', () => {
  stateStore.clear();
  stateStore.recordPriors('demo', { a: 1 });
  stateStore.recordPriors('demo', { a: 2, b: 3 });
  assert.deepEqual(stateStore.getPriors('demo'), { a: 1, b: 3 });
  stateStore.markRemoved('demo');
  assert.equal(stateStore.getPriors('demo'), undefined);
});

test('strict JSON rejects empty and whitespace-only existing files', () => {
  const file = path.join(home, 'empty.json');
  for (const content of ['', ' \n\t']) {
    fs.writeFileSync(file, content);
    assert.throws(() => readJsonObjectStrict(file), /Cannot parse/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('backups keep distinct flattened paths and manifest contents', async () => {
  const { backupFile } = await import('../dist/lib/core/safe-write.js');
  const first = path.join(home, 'a', 'b.json');
  const second = path.join(home, 'a__b.json');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  const a = backupFile(first);
  const b = backupFile(second);
  assert.notEqual(a, b);
  assert.equal(fs.readFileSync(a, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b, 'utf8'), 'second');
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(a), 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some(entry => entry.source === first && entry.backup === a));
  assert.ok(manifest.files.some(entry => entry.source === second && entry.backup === b));
});

test('writes and removals reject symlinks without replacing the link or target', async () => {
  const { atomicWriteFile, writeJsonOrRemove } = await import('../dist/lib/core/safe-write.js');
  const target = path.join(home, 'target.json');
  const link = path.join(home, 'linked.json');
  fs.writeFileSync(target, '{"keep":true}');
  fs.symlinkSync(target, link);
  for (const operation of [() => atomicWriteFile(link, '{}'), () => safeWriteFile(link, '{}'), () => writeJsonOrRemove(link, {})]) {
    assert.throws(operation, /symbolic link/);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"keep":true}');
  }
  const dangling = path.join(home, 'dangling.json');
  fs.symlinkSync(path.join(home, 'absent-target.json'), dangling);
  assert.throws(() => atomicWriteFile(dangling, '{}'), /symbolic link/);
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
});

test('state priors are scoped to tool and resolved configuration path', () => {
  stateStore.clear();
  const a = path.join(home, 'xdg-a', 'opencode.json');
  const b = path.join(home, 'xdg-b', 'opencode.json');
  stateStore.recordPriors('opencode', { model: 'a' }, a);
  stateStore.recordPriors('opencode', { model: 'b' }, b);
  stateStore.recordPriors('opencode', { model: 'changed' }, a);
  assert.deepEqual(stateStore.getPriors('opencode', a), { model: 'a' });
  assert.deepEqual(stateStore.getPriors('opencode', b), { model: 'b' });
  stateStore.markRemoved('opencode', b);
  assert.equal(stateStore.getPriors('opencode', b), undefined);
  assert.deepEqual(stateStore.getPriors('opencode', a), { model: 'a' });
});
