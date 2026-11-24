import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-dvc-test-'));
process.env.WORKSPACE_DIR = tempDir;

const { initDefaultTemplate } = await import('../dist-server/services/workspace.js');
const {
  registerDataFile,
  getManifestSummary,
  verifyManifest,
  removeManifestEntry,
  untrackRawFromGit
} = await import('../dist-server/services/dataManifest.js');

test('Data Provenance Manifest & Leak Audit Suite', async (t) => {
  await t.test('registers raw file with SHA-256, script hash, and syncs Markdown + web-report mirror', async () => {
    initDefaultTemplate();

    fs.writeFileSync(path.join(tempDir, 'code/download_geo.py'), 'print("downloading GSE12345")\n', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'data/raw/counts.csv'), 'gene,c1,t1\nTP53,10,50\n', 'utf-8');

    const entry = await registerDataFile({
      filepath: 'data/raw/counts.csv',
      description: 'RNA-seq count matrix from GSE12345',
      acquisition: {
        method: 'script',
        scriptPath: 'code/download_geo.py',
        command: 'python code/download_geo.py'
      }
    });

    assert.equal(entry.filepath, 'data/raw/counts.csv');
    assert.equal(entry.sha256.length, 64);
    assert.ok(entry.acquisition.scriptSha256 && entry.acquisition.scriptSha256.length === 64);

    // Markdown mirror and metadata-only web-report mirror updated automatically
    const md = fs.readFileSync(path.join(tempDir, 'data/DATA_MANIFEST.md'), 'utf-8');
    assert.ok(md.includes('data/raw/counts.csv'));
    assert.ok(md.includes('RNA-seq count matrix from GSE12345'));
    assert.ok(md.includes('code/download_geo.py'));

    const webMirror = JSON.parse(fs.readFileSync(path.join(tempDir, 'web-report/data/data_manifest.json'), 'utf-8'));
    assert.equal(webMirror.entries.length, 1);
    assert.equal(webMirror.entries[0].sha256, entry.sha256);
  });

  await t.test('detects verified, modified, scriptChanged, untracked, and missing states', async () => {
    // Initially verified
    let report = await verifyManifest();
    assert.equal(report.entries[0].status, 'verified');
    assert.equal(report.entries[0].scriptChanged, false);
    assert.equal(report.hasIssues, false);

    // Add untracked raw file -> detected passively by getManifestSummary
    fs.writeFileSync(path.join(tempDir, 'data/raw/extra.tsv'), 'a\tb\n1\t2\n', 'utf-8');
    const summary = getManifestSummary();
    assert.equal(summary.untrackedRawFiles.length, 1);
    assert.equal(summary.untrackedRawFiles[0].filepath, 'data/raw/extra.tsv');
    assert.equal(summary.hasIssues, true);

    // Modify registered raw file & download script -> detected by verifyManifest
    fs.writeFileSync(path.join(tempDir, 'data/raw/counts.csv'), 'gene,c1,t1\nTP53,10,999\n', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'code/download_geo.py'), 'print("changed")\n', 'utf-8');
    report = await verifyManifest();
    assert.equal(report.entries[0].status, 'modified');
    assert.equal(report.entries[0].scriptChanged, true);

    // Delete raw file -> missing
    fs.unlinkSync(path.join(tempDir, 'data/raw/counts.csv'));
    report = await verifyManifest();
    assert.equal(report.entries[0].status, 'missing');

    // Restore original content for leak tests
    fs.writeFileSync(path.join(tempDir, 'data/raw/counts.csv'), 'gene,c1,t1\nTP53,10,50\n', 'utf-8');
    fs.unlinkSync(path.join(tempDir, 'data/raw/extra.tsv'));
  });

  await t.test('detects publication leaks in web-report/ without 0-byte false positives', async () => {
    // Register a 0-byte file and put an unrelated 0-byte file in web-report -> must NOT false-positive
    fs.writeFileSync(path.join(tempDir, 'data/raw/empty.csv'), '');
    await registerDataFile({ filepath: 'data/raw/empty.csv', description: 'empty placeholder' });
    fs.writeFileSync(path.join(tempDir, 'web-report/empty_marker.txt'), '');

    // Copy non-empty registered raw file into web-report -> hash_match leak
    fs.copyFileSync(path.join(tempDir, 'data/raw/counts.csv'), path.join(tempDir, 'web-report/leaked_copy.csv'));
    // Symlink into data/raw -> symlink_to_raw leak
    fs.symlinkSync(path.join(tempDir, 'data/raw/counts.csv'), path.join(tempDir, 'web-report/leaked_link.csv'));
    // Raw bioinformatics extension (including compound .fastq.gz) & directory symlink to data/
    fs.writeFileSync(path.join(tempDir, 'web-report/reads.fastq.gz'), 'gz-fake');
    fs.symlinkSync(path.join(tempDir, 'data'), path.join(tempDir, 'web-report/data_dir_link'));

    const report = await verifyManifest();
    const reasons = report.leaks.publicationLeaks.map((l) => `${l.path}:${l.reason}`);

    assert.ok(reasons.includes('web-report/leaked_copy.csv:hash_match'));
    assert.ok(reasons.includes('web-report/leaked_link.csv:symlink_to_raw'));
    assert.ok(reasons.includes('web-report/data_dir_link:symlink_to_raw'));
    assert.ok(reasons.includes('web-report/reads.fastq.gz:raw_extension'));
    assert.equal(
      report.leaks.publicationLeaks.some((l) => l.path === 'web-report/empty_marker.txt'),
      false,
      '0-byte files must not trigger hash_match false positives'
    );

    // Clean up leaks
    fs.unlinkSync(path.join(tempDir, 'web-report/leaked_copy.csv'));
    fs.unlinkSync(path.join(tempDir, 'web-report/leaked_link.csv'));
    fs.unlinkSync(path.join(tempDir, 'web-report/data_dir_link'));
    fs.unlinkSync(path.join(tempDir, 'web-report/reads.fastq.gz'));
    fs.unlinkSync(path.join(tempDir, 'web-report/empty_marker.txt'));
  });

  await t.test('rejects untrackRawFromGit path traversal bypass and allows clearing acquisition fields', async () => {
    await assert.rejects(
      () => untrackRawFromGit('data/raw/../../SPEC.md'),
      /Only files inside data\/raw\//
    );

    const cleared = await registerDataFile({
      filepath: 'data/raw/counts.csv',
      description: 'Updated description',
      acquisition: {
        method: 'manual',
        scriptPath: '',
        command: '',
        sourceUrl: ''
      }
    });
    assert.equal(cleared.acquisition.scriptPath, undefined);
    assert.equal(cleared.acquisition.command, undefined);
    assert.equal(cleared.acquisition.sourceUrl, undefined);
  });

  await t.test('detects Git-tracked raw files and warns about Git commit history on untrack', async () => {
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test Scientist'], { cwd: tempDir });
    // Force-add raw file to simulate accidental commit
    execFileSync('git', ['add', '-f', 'data/raw/counts.csv'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'accidental raw commit'], { cwd: tempDir });

    const before = await verifyManifest();
    assert.equal(before.leaks.isGitRepo, true);
    assert.ok(before.leaks.gitTrackedRawFiles.includes('data/raw/counts.csv'));

    const res = await untrackRawFromGit('data/raw/counts.csv');
    assert.equal(res.success, true);
    assert.equal(res.inGitHistory, true);
    assert.ok(res.warning && res.warning.includes('previous Git commit history'));
    // Local file MUST still exist on disk
    assert.ok(fs.existsSync(path.join(tempDir, 'data/raw/counts.csv')));

    const after = await verifyManifest();
    assert.equal(after.leaks.gitTrackedRawFiles.includes('data/raw/counts.csv'), false);
  });

  await t.test('removes manifest entry without deleting raw file on disk', async () => {
    const summary = getManifestSummary();
    const countsEntry = summary.entries.find((e) => e.filepath === 'data/raw/counts.csv');
    assert.ok(countsEntry);
    const removed = await removeManifestEntry(countsEntry.id);
    assert.equal(removed, true);
    assert.ok(fs.existsSync(path.join(tempDir, 'data/raw/counts.csv')));
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
