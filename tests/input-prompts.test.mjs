import assert from 'node:assert/strict'; import test from 'node:test'; import { runPrompt } from './helpers/prompt-pty.mjs';
const head = `import { checkPrompt, secretPrompt, textPrompt } from './dist/lib/wizard/ui/prompts.js';`;
test('real PTY secret entry masks pasted credentials and Esc cancels', { skip: process.platform === 'win32' }, async () => {
 const out = await runPrompt(head + `const v = await secretPrompt({message:'SECRET_READY',escape:true}); console.log('RESULT', v === undefined ? 'cancel' : v.length);`, [['SECRET_READY', 'sk-test-credential-123456789'], ['6789', '\x1b']]);
 assert.match(out, /RESULT.*cancel/); assert.equal(out.includes('sk-test-credential-123456789'), false);
});
test('real PTY text cancellation differs from confirming an empty value', { skip: process.platform === 'win32' }, async () => {
 const out = await runPrompt(head + `console.log('RESULT', JSON.stringify(await textPrompt({message:'TEXT_READY'})) ?? 'cancel');`, [['TEXT_READY', '\x1b']]); assert.match(out, /RESULT.*cancel/);
});
test('real PTY checkbox Esc returns undefined without choosing an item', { skip: process.platform === 'win32' }, async () => {
 const out = await runPrompt(head + `console.log('RESULT', JSON.stringify(await checkPrompt({message:'CHECK_READY',items:[{value:'a',label:'Alpha'},{value:'b',label:'Beta'}]})) ?? 'cancel');`, [['CHECK_READY', '\x1b']]); assert.match(out, /RESULT.*cancel/);
});
