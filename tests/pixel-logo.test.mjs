import assert from 'node:assert/strict'; import test from 'node:test';
import {SPRITES,spriteGrid,logoGrid,renderGrid,joinBlocks} from '../dist/lib/wizard/ui/pixel.js';
import {stripAnsi,visibleWidth} from '../dist/utils/string-width.js';
test('every tool sprite is 12 by 10 pixels and renders five terminal rows',()=>{
 for(const id of Object.keys(SPRITES)){const grid=spriteGrid(id);assert.equal(grid.length,10,id);assert.ok(grid.every(row=>row.length===12),id);const rows=renderGrid(grid);assert.equal(rows.length,5);assert.ok(rows.every(row=>visibleWidth(row)===12));}
 assert.equal(logoGrid()[0].length,32);assert.equal(spriteGrid('missing'),undefined);
});
test('pixel pairs and joined blocks preserve terminal widths',()=>{
 assert.equal(stripAnsi(renderGrid([['#ff0000',undefined,'#00ff00','#0000ff'],[undefined,'#ff0000','#00ff00','#ff0000']])[0]),'▀▄█▀');
 assert.deepEqual(joinBlocks([['ab'],['x','y']],[3,1],1).map(stripAnsi),['    x','ab  y']);
});
