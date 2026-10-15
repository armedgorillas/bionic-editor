#!/usr/bin/env node

/**
 * Semantic Beta Release Versioning Helper
 * Computes the next semantic beta version based on package.json and git tags.
 *
 * Supported flags:
 *   --get-version   Outputs version (e.g., "0.1.0-beta.1")
 *   --get-tag       Outputs git tag (e.g., "v0.1.0-beta.1")
 *   --bump          Updates package.json with the next version
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function parseSemver(v) {
  const clean = v.replace(/^v/, '').trim();
  // Match standard semver with beta prerelease: 0.1.0-beta.1, 0.1.0-beta, 0.1.0
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta(?:\.(\d+))?)?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    beta: match[4] !== undefined ? parseInt(match[4], 10) : (clean.includes('-beta') ? 0 : null)
  };
}

export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Handle beta comparison
  const aBeta = a.beta !== null ? a.beta : 999999;
  const bBeta = b.beta !== null ? b.beta : 999999;
  return aBeta - bBeta;
}

export function getGitTags() {
  try {
    const stdout = execSync('git tag -l "v*"', { cwd: rootDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return stdout
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getNextVersion(customBaseVersion, existingTags = null) {
  const tags = existingTags !== null ? existingTags : getGitTags();

  let baseVersion = customBaseVersion;
  if (!baseVersion) {
    const pkgPath = path.join(rootDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    baseVersion = pkg.version || '0.1.0-beta.1';
  }

  // Allow manual override via env
  if (process.env.RELEASE_VERSION) {
    const clean = process.env.RELEASE_VERSION.replace(/^v/, '').trim();
    if (parseSemver(clean)) {
      return clean;
    }
  }

  const baseParsed = parseSemver(baseVersion) || { major: 0, minor: 1, patch: 0, beta: 1 };
  const basePrefix = `${baseParsed.major}.${baseParsed.minor}.${baseParsed.patch}`;

  // Find all beta tags matching this major.minor.patch
  let maxBeta = 0;
  let matchingTagFound = false;

  for (const tag of tags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;

    const tagPrefix = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (tagPrefix === basePrefix && parsed.beta !== null) {
      matchingTagFound = true;
      if (parsed.beta > maxBeta) {
        maxBeta = parsed.beta;
      }
    }
  }

  if (!matchingTagFound) {
    // If no existing tag for this base prefix, start at baseParsed beta (or default to 1)
    const initialBeta = baseParsed.beta && baseParsed.beta > 0 ? baseParsed.beta : 1;
    return `${basePrefix}-beta.${initialBeta}`;
  }

  const nextBeta = maxBeta + 1;
  return `${basePrefix}-beta.${nextBeta}`;
}

// CLI Execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const nextVer = getNextVersion();
  const nextTag = `v${nextVer}`;

  if (args.includes('--bump')) {
    const pkgPath = path.join(rootDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.version = nextVer;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

    // Also update client/package.json if exists
    const clientPkgPath = path.join(rootDir, 'client', 'package.json');
    if (fs.existsSync(clientPkgPath)) {
      const clientPkg = JSON.parse(fs.readFileSync(clientPkgPath, 'utf-8'));
      clientPkg.version = nextVer;
      fs.writeFileSync(clientPkgPath, JSON.stringify(clientPkg, null, 2) + '\n', 'utf-8');
    }

    console.log(`Updated package.json version to ${nextVer}`);
  } else if (args.includes('--get-tag')) {
    console.log(nextTag);
  } else {
    console.log(nextVer);
  }
}
