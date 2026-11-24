import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-wscfg-test-'));
process.env.WORKSPACE_DIR = tempDir;
delete process.env.BASE_SPEC;
delete process.env.SPEC_FILE;

const {
  getResolvedWorkspaceConfig,
  getProjectRootFile,
  updateWorkspaceConfig
} = await import('../dist-server/services/workspaceConfig.js');
const { refreshManagedSystemPrompt } = await import('../dist-server/services/opencodeConfig.js');

test('Workspace Project Root File Configuration Suite', async (t) => {
  await t.test('defaults to SPEC.md when no config file or env var exists', () => {
    const cfg = getResolvedWorkspaceConfig();
    assert.equal(cfg.rootFile, 'SPEC.md');
    assert.equal(cfg.baseSpec, 'SPEC.md');
    assert.equal(cfg.source, 'default');
    assert.equal(getProjectRootFile(), 'SPEC.md');
  });

  await t.test('updates .bionic/config.json and creates missing root plan with 5-section format', () => {
    const updated = updateWorkspaceConfig({ rootFile: 'plans/MAIN_PLAN.md', createIfMissing: true });
    assert.equal(updated.rootFile, 'plans/MAIN_PLAN.md');
    assert.equal(updated.source, 'workspace');
    assert.equal(getProjectRootFile(), 'plans/MAIN_PLAN.md');

    const createdPath = path.join(tempDir, 'plans/MAIN_PLAN.md');
    assert.ok(fs.existsSync(createdPath));
    const content = fs.readFileSync(createdPath, 'utf-8');
    assert.ok(content.includes('## Research Question'));
    assert.ok(content.includes('## Data Sourcing'));
    assert.ok(content.includes('## Data Processing'));
    assert.ok(content.includes('## Data Display'));
    assert.ok(content.includes('## Tests'));

    // Refreshing managed system prompt dynamically references the new root file
    const promptPath = refreshManagedSystemPrompt();
    const prompt = fs.readFileSync(promptPath, 'utf-8');
    assert.ok(prompt.includes('plans/MAIN_PLAN.md'));
  });

  await t.test('rejects path traversal and directory paths for rootFile', () => {
    assert.throws(() => {
      updateWorkspaceConfig({ rootFile: '../escape.md' });
    }, /Access denied/);

    fs.mkdirSync(path.join(tempDir, 'subdir'), { recursive: true });
    assert.throws(() => {
      updateWorkspaceConfig({ rootFile: 'subdir' });
    }, /cannot be a directory/);
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
