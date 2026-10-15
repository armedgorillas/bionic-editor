import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseSemver, compareSemver, getNextVersion } from '../scripts/release-version.mjs';

const rootDir = path.resolve('.');

test('Packaging, CLI and Semantic Versioning Suite', async (t) => {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  await t.test('package.json has valid semantic beta version', () => {
    assert.ok(pkg.version, 'package.json must specify version');
    const semverRegex = /^\d+\.\d+\.\d+-beta(\.\d+)?$/;
    assert.match(pkg.version, semverRegex, `Version "${pkg.version}" must be a semantic beta release (e.g. 0.1.0-beta.1)`);
  });

  await t.test('package.json configures bin, main, and distribution files', () => {
    assert.equal(pkg.main, 'dist-server/index.js');
    assert.ok(pkg.bin && pkg.bin.bioniceditor);
    assert.ok(pkg.bin['bionic-editor']);
    assert.ok(Array.isArray(pkg.files));
    assert.ok(pkg.files.includes('bin'));
    assert.ok(pkg.files.includes('dist-server'));
    assert.ok(pkg.files.includes('client/dist'));
  });

  await t.test('CLI executable exists and has proper shebang', () => {
    const binPath = path.join(rootDir, 'bin', 'bioniceditor.js');
    assert.ok(fs.existsSync(binPath));
    const content = fs.readFileSync(binPath, 'utf-8');
    assert.ok(content.startsWith('#!/usr/bin/env node'));
  });

  await t.test('CLI responds to --help and --version', () => {
    const helpOutput = execSync(`node bin/bioniceditor.js --help`, { cwd: rootDir, encoding: 'utf-8' });
    assert.ok(helpOutput.includes('Bionic Editor - Scientific Document & Analysis IDE'));
    assert.ok(helpOutput.includes('--workspace'));
    assert.ok(helpOutput.includes('--port'));

    const versionOutput = execSync(`node bin/bioniceditor.js --version`, { cwd: rootDir, encoding: 'utf-8' });
    assert.ok(versionOutput.includes(`v${pkg.version}`));
  });

  await t.test('Semantic versioning helper correctly parses and compares semver versions', () => {
    const v1 = parseSemver('0.1.0-beta.1');
    assert.deepEqual(v1, { major: 0, minor: 1, patch: 0, beta: 1 });

    const v2 = parseSemver('v0.1.0-beta.2');
    assert.deepEqual(v2, { major: 0, minor: 1, patch: 0, beta: 2 });

    assert.ok(compareSemver(v1, v2) < 0);
    assert.ok(compareSemver(v2, v1) > 0);
    assert.equal(compareSemver(v1, v1), 0);
  });

  await t.test('getNextVersion computes consecutive beta tags', () => {
    // When no tags exist, uses base version in package.json
    const initial = getNextVersion('0.1.0-beta.1', []);
    assert.equal(initial, '0.1.0-beta.1');

    // When tags exist, increments the beta suffix
    const nextFromTags = getNextVersion('0.1.0-beta.1', ['v0.1.0-beta.1', 'v0.1.0-beta.2']);
    assert.equal(nextFromTags, '0.1.0-beta.3');

    // When new minor base version is specified, resets beta for that minor version
    const nextMinor = getNextVersion('0.2.0-beta.1', ['v0.1.0-beta.1', 'v0.1.0-beta.2']);
    assert.equal(nextMinor, '0.2.0-beta.1');
  });

  await t.test('npm pack includes required distribution artifacts and excludes sensitive files', () => {
    const rawOutput = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: rootDir, encoding: 'utf-8' });
    const jsonStart = rawOutput.indexOf('[');
    const jsonEnd = rawOutput.lastIndexOf(']');
    assert.ok(jsonStart !== -1 && jsonEnd !== -1, 'Could not find JSON array in npm pack output');
    const packInfo = JSON.parse(rawOutput.slice(jsonStart, jsonEnd + 1));
    assert.ok(Array.isArray(packInfo) && packInfo.length > 0);

    const files = packInfo[0].files.map(f => f.path);

    // Must be present
    assert.ok(files.some(f => f.includes('bin/bioniceditor.js')), 'bin/bioniceditor.js missing from package');
    assert.ok(files.some(f => f.includes('dist-server/index.js')), 'dist-server/index.js missing from package');
    assert.ok(files.some(f => f.includes('client/dist/index.html')), 'client/dist/index.html missing from package');
    assert.ok(files.some(f => f.includes('package.json')), 'package.json missing from package');

    // Must NOT be present
    assert.ok(!files.some(f => f === '.env' || f.endsWith('/.env') || f.startsWith('.env.')), '.env leaked in package');
    assert.ok(!files.some(f => f.startsWith('workspace/')), 'workspace directory leaked in package');
    assert.ok(!files.some(f => f.startsWith('tests/')), 'tests directory leaked in package');
  });
});
