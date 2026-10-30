import assert from 'node:assert/strict'; import test from 'node:test';
import { runPrompt } from './helpers/prompt-pty.mjs';
const head = `import { menuPrompt } from './dist/lib/wizard/ui/prompts.js';`;
const options = `{message:'MENU_READY',escape:true,items:[{value:'a',label:'Alpha'},{value:'b',label:'Beta'}]}`;
test('real PTY menu arrows select a row in a narrow terminal', { skip: process.platform === 'win32' }, async () => {
 const out = await runPrompt(head + `console.log('RESULT', JSON.stringify(await menuPrompt(${options})));`, [['MENU_READY', '\x1b[B'], ['Beta', '\r']], 32);
 assert.match(out, /RESULT.*"value":"b"/);
});
test('real PTY empty search supports clearing then Esc cancellation', { skip: process.platform === 'win32' }, async () => {
 const out = await runPrompt(head + `console.log('RESULT', JSON.stringify(await menuPrompt({...${options},searchable:true})));`, [['MENU_READY', 'zzzz'], ['zzzz', '\x1b'], ['Alpha', '\x1b']], 40);
 assert.match(out, /RESULT.*"action":"escape"/);
});
