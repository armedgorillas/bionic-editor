import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Setup isolated temp directory before importing workspace service
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-ws-test-'));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-outside-'));
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret', 'utf-8');
process.env.WORKSPACE_DIR = tempDir;

const {
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
    assert.equal(isPathSafe('bad\0path.txt'), false);
  });

  await t.test('resolveSafePath prevents directory traversal and symlink escapes', () => {
    const safe = resolveSafePath('data/raw/sample.csv');
    assert.equal(safe, path.join(tempDir, 'data/raw/sample.csv'));

    assert.throws(() => {
      resolveSafePath('../outside.txt');
    }, /Access denied/);

    assert.throws(() => {
      resolveSafePath('../../etc/passwd');
    }, /Access denied/);

    // Symlink escape test (existing external directory)
    const escapeLink = path.join(tempDir, 'escape_link');
    fs.symlinkSync(outsideDir, escapeLink);
    assert.equal(isPathSafe('escape_link/secret.txt'), false);
    assert.throws(() => {
      resolveSafePath('escape_link/secret.txt');
    }, /Access denied/);
    fs.unlinkSync(escapeLink);

    // Dangling symlink escape test (non-existent external target)
    const danglingLink = path.join(tempDir, 'dangling_escape.txt');
    fs.symlinkSync(path.join(outsideDir, 'never_created.txt'), danglingLink);
    assert.equal(isPathSafe('dangling_escape.txt'), false);
    assert.throws(() => {
      resolveSafePath('dangling_escape.txt');
    }, /Access denied/);
    fs.unlinkSync(danglingLink);
  });

  await t.test('fileWatcher ignore predicate skips .venv/.git/.bionic/sessions while observing .gitignore/.opencode', async () => {
    const { shouldIgnoreWatchedPath } = await import('../dist-server/services/fileWatcher.js');
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, '.venv/lib/python3.12/site.py')), true);
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, '.git/HEAD')), true);
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, '.bionic/sessions/s1.json')), true);
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, 'data/manifest.json.tmp.1234.abc')), true);
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, '.gitignore')), false);
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, '.opencode/opencode.jsonc')), false);
    assert.equal(shouldIgnoreWatchedPath(path.join(tempDir, '.bionic/config.json')), false);
  });

  await t.test('initDefaultTemplate creates scientific plan structure without sample dataset', () => {
    initDefaultTemplate();

    assert.ok(fs.existsSync(path.join(tempDir, 'SPEC.md')));
    assert.ok(fs.existsSync(path.join(tempDir, 'plans')));
    assert.ok(fs.existsSync(path.join(tempDir, 'code')));
    assert.ok(fs.existsSync(path.join(tempDir, 'data/raw/.gitkeep')));
    assert.ok(fs.existsSync(path.join(tempDir, 'data/manifest.json')));
    assert.ok(fs.existsSync(path.join(tempDir, 'data/DATA_MANIFEST.md')));
    assert.ok(fs.existsSync(path.join(tempDir, 'tests/scientific')));
    assert.ok(fs.existsSync(path.join(tempDir, 'web-report/index.html')));
    assert.ok(fs.existsSync(path.join(tempDir, 'web-report/data/data_manifest.json')));
    assert.ok(fs.existsSync(path.join(tempDir, 'requirements.txt')));

    // Sample dataset must NOT be created in new workspaces
    assert.equal(fs.existsSync(path.join(tempDir, 'data/raw/gene_expression_sample.csv')), false);
    assert.equal(fs.existsSync(path.join(tempDir, 'src/analyze.py')), false);

    // Managed .gitignore must exclude raw data, .env, and .bionic/sessions
    const gitignore = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('data/raw/*'));
    assert.ok(gitignore.includes('.env'));
    assert.ok(gitignore.includes('.bionic/sessions/'));
  });

  await t.test('readFileContent reads 5-section starter Plan and detects missing files', () => {
    const res = readFileContent('SPEC.md');
    assert.equal(res.isBinary, false);
    assert.ok(res.content.includes('Scientific Experiment & Analysis Plan'));
    assert.ok(res.content.includes('## Research Question'));
    assert.ok(res.content.includes('## Data Sourcing'));
    assert.ok(res.content.includes('## Data Processing'));
    assert.ok(res.content.includes('## Data Display'));
    assert.ok(res.content.includes('## Tests'));
    assert.ok(res.content.includes('tests/scientific/'));

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

    assert.throws(() => {
      deleteItem('');
    }, /Access denied: Cannot delete workspace root/);
  });

  await t.test('getFileTree tags isDotItem/category, supports opt-in dot items, and survives broken symlinks', () => {
    // Create a broken symlink to ensure getFileTree never crashes
    const brokenLink = path.join(tempDir, 'broken_link.csv');
    fs.symlinkSync(path.join(tempDir, 'does_not_exist.csv'), brokenLink);

    const treeNoDots = getFileTree();
    assert.ok(Array.isArray(treeNoDots));
    const spec = treeNoDots.find(i => i.name === 'SPEC.md');
    assert.ok(spec && !spec.isDirectory && spec.category === 'document');

    const codeDir = treeNoDots.find(i => i.name === 'code');
    assert.ok(codeDir && codeDir.isDirectory && codeDir.category === 'code');

    const plansDir = treeNoDots.find(i => i.name === 'plans');
    assert.ok(plansDir && plansDir.isDirectory && plansDir.category === 'plan');

    // Dotfiles hidden by default
    assert.equal(treeNoDots.some(i => i.name === '.gitignore'), false);

    // Dotfiles included when requested, tagged isDotItem=true
    const treeWithDots = getFileTree(tempDir, '', { includeDotItems: true });
    const gitignore = treeWithDots.find(i => i.name === '.gitignore');
    assert.ok(gitignore && gitignore.isDotItem === true);

    fs.unlinkSync(brokenLink);
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
