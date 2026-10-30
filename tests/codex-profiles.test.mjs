import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profiles-'));
const { configManager } = await import('../dist/lib/config.js');
const { CodexTool, mergeCodexProfiles, buildCodexProfileFile } = await import('../dist/lib/tools/codex-tool.js');
const file = path.join(process.env.HOME, '.codex/config.toml');
test.after(() => fs.rmSync(process.env.HOME, { recursive: true, force: true }));
test('Codex profile providers preserve user configuration and escape strings', () => {
 const text = mergeCodexProfiles('[profiles.mine]\nmodel = "x"\n', [{ name: 'work', apiKey: 'sk-"secret', baseUrl: 'https://example.com' }]);
 assert.match(text, /profiles.mine/); assert.match(text, /model_providers.qnaigc-work/); assert.doesNotMatch(text, /profiles.qn-work/);
 assert.match(buildCodexProfileFile('work', 'm'), /model_provider = "qnaigc-work"/);
 assert.throws(() => mergeCodexProfiles('[model_providers.qnaigc-work]\nname = "Mine"\n', [{ name: 'work', apiKey: 'x', baseUrl: 'https://example.com' }]));
});
test('adding profiles extends the existing transaction and restore preserves original bytes', async () => {
 fs.mkdirSync(path.dirname(file), { recursive: true }); const original = '# user config\nmodel = "original"\n'; fs.writeFileSync(file, original);
 const tool = new CodexTool(); await tool.loadConfig('sk-current', 'https://api.qnaigc.com', {});
 configManager.saveProfile('work', 'sk-work', 'china'); await tool.loadConfig('sk-current', 'https://api.qnaigc.com', {});
 const profileFile = path.join(process.env.HOME, '.codex/qn-work.config.toml'); assert.ok(fs.existsSync(profileFile));
 configManager.saveProfile('home', 'sk-home', 'international'); await tool.loadConfig('sk-current', 'https://api.qnaigc.com', {});
 const before = fs.readFileSync(file, 'utf8'); fs.appendFileSync(profileFile, '# external edit\n'); await assert.rejects(tool.unloadConfig()); assert.equal(fs.readFileSync(file, 'utf8'), before);
 fs.writeFileSync(profileFile, buildCodexProfileFile('work', tool.defaultModel, path.join(process.env.HOME, '.codex/model-catalogs/qnaigc.json')));
 await tool.unloadConfig(); assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(fs.existsSync(profileFile), false);
});
