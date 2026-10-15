import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Setup isolated temp directory before importing workspace service
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-ws-test-'));
process.env.WORKSPACE_DIR = tempDir;

const {
  ensureWorkspaceDir,
  initDefaultTemplate,
  isPathSafe,
  resolveSafePath,
  getFileTree,
  readFileContent,
  writeFileContent,
  createItem,
  renameItem,
  deleteItem
} = await import('../dist-server/services/workspace.js');

test('Workspace Service Unit Tests', async (t) => {
  await t.test('isPathSafe correctly validates inside and outside paths', () => {
    assert.equal(isPathSafe('SPEC.md'), true);
    assert.equal(isPathSafe('data/raw/sample.csv'), true);
    assert.equal(isPathSafe('./data/processed'), true);

    // Path traversal attacks must fail
    assert.equal(isPathSafe('../outside.txt'), false);
    assert.equal(isPathSafe('../../etc/passwd'), false);
    assert.equal(isPathSafe('/etc/passwd'), false);
    assert.equal(isPathSafe('data/../../outside.txt'), false);
  });

  await t.test('resolveSafePath prevents directory traversal', () => {
    const safe = resolveSafePath('data/raw/sample.csv');
    assert.equal(safe, path.join(tempDir, 'data/raw/sample.csv'));

    assert.throws(() => {
      resolveSafePath('../outside.txt');
    }, /Access denied: Path is outside workspace/);

    assert.throws(() => {
      resolveSafePath('../../etc/passwd');
    }, /Access denied: Path is outside workspace/);
  });

  await t.test('initDefaultTemplate creates Cookiecutter scientific structure', () => {
    initDefaultTemplate();

    assert.ok(fs.existsSync(path.join(tempDir, 'SPEC.md')));
    assert.ok(fs.existsSync(path.join(tempDir, 'data/raw/gene_expression_sample.csv')));
    assert.ok(fs.existsSync(path.join(tempDir, 'src/analyze.py')));
    assert.ok(fs.existsSync(path.join(tempDir, 'web-report/index.html')));
    assert.ok(fs.existsSync(path.join(tempDir, 'requirements.txt')));
  });

  await t.test('readFileContent reads text and detects missing files', () => {
    const res = readFileContent('SPEC.md');
    assert.equal(res.isBinary, false);
    assert.ok(res.content.includes('Scientific Experiment & Analysis Plan'));

    assert.throws(() => {
      readFileContent('non_existent_file.txt');
    }, /File not found/);

    assert.throws(() => {
      readFileContent('data');
    }, /Path is a directory/);
  });

  await t.test('writeFileContent writes content and auto-creates subdirectories', () => {
    writeFileContent('experiments/run_01/notes.txt', 'Experiment notes content');
    const read = readFileContent('experiments/run_01/notes.txt');
    assert.equal(read.content, 'Experiment notes content');
  });

  await t.test('createItem creates files and directories, rejecting existing items', () => {
    createItem('experiments/run_02', true);
    assert.ok(fs.statSync(path.join(tempDir, 'experiments/run_02')).isDirectory());

    createItem('experiments/run_02/marker.tsv', false);
    assert.ok(fs.existsSync(path.join(tempDir, 'experiments/run_02/marker.tsv')));

    assert.throws(() => {
      createItem('experiments/run_02/marker.tsv', false);
    }, /Target already exists/);
  });

  await t.test('renameItem renames files and moves them safely', () => {
    renameItem('experiments/run_02/marker.tsv', 'experiments/run_02/renamed_marker.tsv');
    assert.ok(fs.existsSync(path.join(tempDir, 'experiments/run_02/renamed_marker.tsv')));
    assert.ok(!fs.existsSync(path.join(tempDir, 'experiments/run_02/marker.tsv')));

    assert.throws(() => {
      renameItem('experiments/run_02/nonexistent.txt', 'experiments/target.txt');
    }, /Source not found/);

    // Root rename protection
    assert.throws(() => {
      renameItem('', 'new_root');
    }, /Access denied: Cannot rename workspace root/);
  });

  await t.test('deleteItem removes files and directories and protects root', () => {
    deleteItem('experiments/run_02/renamed_marker.tsv');
    assert.ok(!fs.existsSync(path.join(tempDir, 'experiments/run_02/renamed_marker.tsv')));

    deleteItem('experiments');
    assert.ok(!fs.existsSync(path.join(tempDir, 'experiments')));

    assert.throws(() => {
      deleteItem('non_existent_path');
    }, /Target not found/);

    // Root deletion protection
    assert.throws(() => {
      deleteItem('');
    }, /Access denied: Cannot delete workspace root/);
  });

  await t.test('getFileTree returns accurate nested tree structure', () => {
    const tree = getFileTree();
    assert.ok(Array.isArray(tree));
    const spec = tree.find(i => i.name === 'SPEC.md');
    assert.ok(spec && !spec.isDirectory);

    const dataDir = tree.find(i => i.name === 'data');
    assert.ok(dataDir && dataDir.isDirectory && Array.isArray(dataDir.children));
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
