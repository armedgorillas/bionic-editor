#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import type { ConfigKind } from '@bionic/shared';

/**
 * Thin declarative GitOps CI CLI (`bionic-ctl`) for syncing version-controlled
 * `templates/`, `models/`, `skills/`, and `mcp/` YAML files to Bionic Hub's Admin API.
 */
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const hubUrl = (process.env.BIONIC_HUB_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const token = process.env.BIONIC_ADMIN_TOKEN || process.env.BIONIC_OIDC_TOKEN || '';

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`Usage:
  bionic-ctl apply --dir <config-repo-dir> [--dry-run] [--git-sha <sha>] [--git-repo <url>]
  bionic-ctl rollback <template|model|skill|mcp> <slug> --version <N>
Environment:
  BIONIC_HUB_URL        Hub base URL (default: http://127.0.0.1:4000)
  BIONIC_ADMIN_TOKEN    Scoped Admin PAT (bht_...) or CI OIDC JWT`);
    process.exit(0);
  }

  if (!token) {
    console.error('ERROR: Set BIONIC_ADMIN_TOKEN (PAT or CI OIDC JWT).');
    process.exit(1);
  }

  if (cmd === 'apply') {
    let dir = '.';
    let dryRun = false;
    let gitCommitSha = process.env.GITHUB_SHA || '';
    let gitRepo = process.env.GITHUB_REPOSITORY || '';

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--dir') dir = args[++i];
      else if (args[i] === '--dry-run') dryRun = true;
      else if (args[i] === '--git-sha') gitCommitSha = args[++i];
      else if (args[i] === '--git-repo') gitRepo = args[++i];
    }

    const dirMap: Array<[string, ConfigKind]> = [
      ['templates', 'template'],
      ['models', 'model'],
      ['skills', 'skill'],
      ['mcp', 'mcp']
    ];

    const items: Array<{ kind: ConfigKind; contentYaml: string }> = [];
    for (const [sub, kind] of dirMap) {
      const fullSub = path.join(dir, sub);
      if (!fs.existsSync(fullSub)) continue;
      for (const entry of fs.readdirSync(fullSub, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
          items.push({ kind, contentYaml: fs.readFileSync(path.join(fullSub, entry.name), 'utf-8') });
        } else if (kind === 'skill' && entry.isDirectory()) {
          const skillYaml = path.join(fullSub, entry.name, 'skill.yaml');
          if (fs.existsSync(skillYaml)) {
            items.push({ kind: 'skill', contentYaml: fs.readFileSync(skillYaml, 'utf-8') });
          }
        }
      }
    }

    const res = await fetch(`${hubUrl}/api/v1/admin/config/apply?dryRun=${dryRun}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ items, gitCommitSha, gitRepo })
    });
    const out = await res.json();
    if (!res.ok) {
      console.error('Apply failed:', JSON.stringify(out, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'rollback') {
    const kind = args[1];
    const slug = args[2];
    const vIdx = args.indexOf('--version');
    const version = vIdx >= 0 ? Number(args[vIdx + 1]) : 0;
    if (!kind || !slug || !version) {
      console.error('Usage: bionic-ctl rollback <kind> <slug> --version <N>');
      process.exit(1);
    }
    const res = await fetch(`${hubUrl}/api/v1/admin/config/${kind}/${slug}/rollback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version })
    });
    const out = await res.json();
    if (!res.ok) {
      console.error('Rollback failed:', JSON.stringify(out, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
