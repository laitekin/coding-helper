import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import { isolateHome } from './helpers/isolated-home.mjs'; import { runPrompt } from './helpers/prompt-pty.mjs';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-view-')); isolateHome(home); test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const { i18n } = await import('../dist/lib/i18n.js'); i18n.init('en_US');
const { renderResultSummary, detectSorted } = await import('../dist/lib/wizard/ui/tool-view.js');
const strip = value => value.replace(/\x1B\[[0-9;]*m/g, '');
function capture(t, fn) { const lines = []; t.mock.method(console, 'log', (...args) => lines.push(strip(args.join(' ')))); fn(); return lines.join('\n'); }
const base = { command: 'demo', installCommand: 'npm i demo', getVersion: () => { throw Error('version must not be probed'); }, isConfigured: () => true };

test('desktop applications keep the restart guidance instead of a shell command', t => {
  const out = capture(t, () => renderResultSummary([{ tool: { ...base, name: 'workbuddy', displayName: 'WorkBuddy', command: 'workbuddy', isInstalled: () => null }, status: 'success' }]));
  assert.match(out, /restart WorkBuddy/); assert.doesNotMatch(out, /run workbuddy/);
});

test('list ordering puts installed tools first without probing versions', () => {
  const tools = [{ ...base, name: 'a', displayName: 'A', isInstalled: () => false }, { ...base, name: 'b', displayName: 'B', isInstalled: () => true }, { ...base, name: 'c', displayName: 'C', isInstalled: () => null }];
  assert.deepEqual(detectSorted(tools).map(d => d.tool.name), ['b', 'c', 'a']);
});

test('narrow confirmation keeps every value visible', { skip: process.platform === 'win32' }, async () => {
  const source = `import {i18n} from './dist/lib/i18n.js';import {safeWriteFile} from './dist/lib/core/safe-write.js';import {confirmAndWrite} from './dist/lib/wizard/ui/write-plan.js';i18n.init('en_US');const tool={name:'claude-code',displayName:'Claude Code',supportsPreview:true,loadConfig:async()=>safeWriteFile(process.env.HOME+'/.claude/settings.json','{}')};await confirmAndWrite('NARROW_READY',[{tool,changes:[{label:'Main model (Sonnet tier)',after:'vendor/main-model'},{label:'Fallback / background model',after:'vendor/slot-model'}],connection:{apiKey:'fake',baseUrl:'https://example.com',endpoint:'china'}}]);`;
  const out = await runPrompt(source, [[/NARROW_READY[\s\S]*?Esc back/, '\x1b']], 40, { rows: 40 });
  for (const text of ['vendor/main-model', 'vendor/slot-model', '.claude/settings.json']) assert.ok(out.includes(text), text);
});
