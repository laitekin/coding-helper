import assert from 'node:assert/strict';
import test from 'node:test';
import {parseYamlDocument,setYamlValue,getYamlValue,restoreYamlValue,stringifyYamlDocument} from '../dist/lib/core/yaml-edit.js';
test('YAML edits preserve comments quotes and unrelated maps',()=>{const doc=parseYamlDocument('# top\nmodel:\n  default: "old" # inline\n  other: yes\nmcp:\n  enabled: true\n');setYamlValue(doc,['model','default'],'new');const next=stringifyYamlDocument(doc);assert.match(next,/# top/);assert.match(next,/"new" # inline/);assert.equal(getYamlValue(doc,['mcp','enabled']),true);assert.equal(getYamlValue(doc,['model','other']),'yes');});
test('flow mappings and special values serialize safely',()=>{const doc=parseYamlDocument('model: {default: old, custom: true}\n');setYamlValue(doc,['model','default'],'x\nnew: bad');assert.equal(getYamlValue(parseYamlDocument(String(doc)),['model','default']),'x\nnew: bad');assert.equal(getYamlValue(doc,['model','custom']),true);});
test('invalid YAML duplicate keys and incompatible parents fail closed',()=>{for(const text of ['x: [', 'x: 1\nx: 2', '[1, 2]', 'null'])assert.throws(()=>parseYamlDocument(text));const doc=parseYamlDocument('model: value\n');assert.throws(()=>setYamlValue(doc,['model','default'],'new'),/mapping/);assert.equal(getYamlValue(doc,['model']),'value');});
test('explicit null differs from missing and empty maps are retained',()=>{const doc=parseYamlDocument('model: {}\n');restoreYamlValue(doc,['model','default'],null);assert.equal(getYamlValue(doc,['model','default']),null);restoreYamlValue(doc,['model','default'],undefined);assert.deepEqual(getYamlValue(doc,['model']),{});});


test('anchors and aliases fail closed rather than changing unrelated configuration', () => {
  for (const content of ['model: {default: &shared old}\nother: *shared\n', 'model: &config {default: old}\nother: *config\n']) {
    assert.throws(() => parseYamlDocument(content), /anchors and aliases/);
  }
});
