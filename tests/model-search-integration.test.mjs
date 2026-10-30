import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrompt } from './helpers/prompt-pty.mjs';
const head = `import { promptHelper } from './dist/lib/wizard/ui/prompt-helper.js'; import { buildHermesModelChoices } from './dist/lib/wizard/flows/hermes-model-selection-flow.js'; const items = buildHermesModelChoices([{id:'z-ai/glm-5.2',name:'GLM',features:['工具调用'],model_constraints:{context_length:256000}},{id:'a/small',name:'Small',features:['工具调用'],model_constraints:{context_length:128000}},{id:'vendor/reasoner',name:'Friendly reasoner',features:['工具调用','深度思考'],model_constraints:{context_length:256000}}]);`;
for (const query of ['glm5', '智谱', '200k']) test('production searchSelect resolves ' + query, {skip:process.platform === 'win32'}, async () => {
 const out = await runPrompt(head + `console.log('RESULT',JSON.stringify(await promptHelper.searchSelect('SEARCH_READY',items)));`, [['SEARCH_READY',query], [query,'\r']]);
 assert.match(out, /RESULT.*"z-ai\/glm-5.2"/);
});

for(const [query,id] of [['工具调用','z-ai/glm-5.2'],['思考','vendor/reasoner'],['Friendly','vendor/reasoner']])test('production search preserves visible name or capability: '+query,{skip:process.platform==='win32'},async()=>{
 const out=await runPrompt(head+`console.log('RESULT',JSON.stringify(await promptHelper.searchSelect('CAP_READY',items)));`,[['CAP_READY',query],[query,'\r']]);assert.ok(out.includes('"'+id+'"'),out);
});
