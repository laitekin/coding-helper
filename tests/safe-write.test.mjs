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
