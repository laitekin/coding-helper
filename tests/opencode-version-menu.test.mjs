import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'opencode-version-'));
process.env.HOME=process.env.USERPROFILE=home;
const {updateTool}=await import('../dist/lib/wizard/menus/tool-menu.js');
const {OpenCodeTool}=await import('../dist/lib/tools/opencode-tool.js');
const {promptHelper}=await import('../dist/lib/wizard/ui/prompt-helper.js');
const {uiRenderer}=await import('../dist/lib/wizard/ui/ui-renderer.js');
test('update menu refuses OpenCode v2 before prompting or executing npm', async()=>{
 const tool=new OpenCodeTool();tool.isInstalled=()=>true;tool.getVersion=()=> '2.0.0';
 const previous=uiRenderer.renderError,confirm=promptHelper.confirm;const errors=[];
 uiRenderer.renderError=message=>errors.push(message);
 promptHelper.confirm=()=>{throw Error('must not prompt');};
 try{await updateTool(tool);assert.match(errors.join('\n'),/1.x only/);}
 finally{uiRenderer.renderError=previous;promptHelper.confirm=confirm;}
});
