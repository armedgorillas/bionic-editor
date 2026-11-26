import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import yaml from 'js-yaml';
import { GoogleAuth } from 'google-auth-library';
import { createId } from '@bionic/shared';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';
import type { DataStorageService } from '../storage/service.js';
import type { GitProvider } from '../gateways/git/proxy.js';

const RAW_BIO_EXTENSIONS = new Set([
  '.fastq', '.fq', '.bam', '.sam', '.cram', '.vcf', '.bcf', '.h5ad', '.loom', '.sra', '.bed', '.bigwig', '.bw'
]);
const RAW_BIO_COMPOUND = ['.fastq.gz', '.fq.gz', '.vcf.gz', '.bcf.gz', '.sam.gz', '.bed.gz'];
const MAX_REPORT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_REPORT_BYTES = 100 * 1024 * 1024;
const MAX_REPORT_FILES = 2000;

export interface PublishIntakeInput {
  projectId: string;
  publishedByUserId: string;
  visibility: 'private' | 'org' | 'public';
  title: string;
  summary: string;
  gitCommitSha: string;
  reportTarballBuffer: Buffer;
  manifestSnapshot?: { entries?: Array<{ filepath: string; sha256: string; storage?: { dataObjectId?: string; uri?: string } }> };
  bionicYaml?: Record<string, any>;
  testResults?: any[];
}

/**
 * Zero-trust server-side Publish service:
 * - Independently inspects the uploaded `web-report/` tarball (never trusts VM's `scripts/publish.sh` alone!)
 * - Validates every manifest dataset against Postgres `project_data_grants`
 * - Enforces hard bucket split (`static-reports-public` vs `static-reports-private`)
 * - Serves atomic `/reports/<slug>/latest` 302 redirects (cached 20s + NOTIFY invalidated)
 * - Handles durable `public -> private/org` downgrade purging
 */
export class PublishService {
  private readonly latestCache = new Map<string, { version: number; expiresAtMs: number }>();
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write']
  });

  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly storage: DataStorageService,
    private readonly git: GitProvider
  ) {
    fs.mkdirSync(path.join(cfg.localStorageDir, 'static-public'), { recursive: true });
    fs.mkdirSync(path.join(cfg.localStorageDir, 'static-private'), { recursive: true });
  }

  /**
   * Independent server-side inspection of the uploaded web-report tarball.
   * Rejects path traversal, symlinks, raw bio extensions, files > 25 MB, missing index.html,
   * and any file whose SHA-256 matches a raw dataset in `data_objects`.
   */
  async inspectReportArchive(
    tarballBuffer: Buffer,
    knownRawHashes: Set<string>
  ): Promise<{ extractDir: string; fileCount: number }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-pub-'));
    const tarFile = path.join(tmpDir, 'report.tar.gz');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(tarFile, tarballBuffer);

    const violations: string[] = [];
    let totalSize = 0;
    let entryCount = 0;
    await tar.list({
      file: tarFile,
      onReadEntry: (entry) => {
        entryCount++;
        totalSize += entry.size || 0;
        if (entryCount > MAX_REPORT_FILES) {
          violations.push(`Archive exceeds maximum ${MAX_REPORT_FILES} files`);
        }
        if (totalSize > MAX_TOTAL_REPORT_BYTES) {
          violations.push(`Archive exceeds maximum ${MAX_TOTAL_REPORT_BYTES} total uncompressed bytes`);
        }
        const clean = entry.path.replace(/^\.\//, '');
        if (clean.includes('..') || path.isAbsolute(clean)) {
          violations.push(`Path traversal entry in report archive: ${entry.path}`);
        }
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          violations.push(`Symlink/hardlink forbidden in published web-report: ${entry.path}`);
        }
        if (entry.size > MAX_REPORT_FILE_BYTES) {
          violations.push(`Oversized file (>25 MB) in web-report: ${entry.path} (${entry.size} bytes)`);
        }
      }
    });

    if (violations.length > 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw Object.assign(new Error(`Server-side publication leak gate failed: ${violations.join('; ')}`), {
        statusCode: 400
      });
    }

    await tar.extract({ file: tarFile, cwd: extractDir, strict: true, preservePaths: false });

    const indexHtml = path.join(extractDir, 'index.html');
    if (!fs.existsSync(indexHtml) || fs.statSync(indexHtml).size === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw Object.assign(new Error('web-report/index.html is missing or empty'), { statusCode: 400 });
    }

    let fileCount = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          violations.push(`Symlink detected after extract: ${entry.name}`);
          continue;
        }
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        fileCount++;
        const lower = entry.name.toLowerCase();
        if (RAW_BIO_EXTENSIONS.has(path.extname(lower)) || RAW_BIO_COMPOUND.some((s) => lower.endsWith(s))) {
          violations.push(`Raw bioinformatics file forbidden in web-report: ${entry.name}`);
        }
        const st = fs.statSync(full);
        if (st.size > MAX_REPORT_FILE_BYTES) {
          violations.push(`Oversized file (>25 MB): ${entry.name}`);
        }
        if (st.size > 0 && knownRawHashes.size > 0) {
          const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          if (knownRawHashes.has(hash)) {
            violations.push(`File ${entry.name} matches SHA-256 of a raw dataset`);
          }
        }
      }
    };
    walk(extractDir);

    if (violations.length > 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw Object.assign(new Error(`Server-side publication leak gate failed: ${violations.join('; ')}`), {
        statusCode: 400
      });
    }

    return { extractDir, fileCount };
  }

  async publishFromIntake(input: PublishIntakeInput): Promise<{
    publicationId: string;
    version: number;
    staticSiteUrl: string;
    visibility: string;
  }> {
    const pubId = createId('pub');

    // 1. Acquire operation lease (`busy_operation` / `busy_until`) to prevent Idle Reaper race (C4)
    const proj = await this.db.withTransaction(async (client) => {
      const res = await client.query(
        `SELECT id, slug, status, template_slug, template_revision_id, busy_until
         FROM projects WHERE id = $1 FOR UPDATE`,
        [input.projectId]
      );
      const row = res.rows[0];
      if (!row) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      if (row.status === 'freezing' || row.status === 'stopping') {
        throw Object.assign(new Error('Project is currently transitioning; retry publish shortly'), {
          statusCode: 409,
          code: 'PROJECT_TRANSITIONING'
        });
      }
      if (row.busy_until && new Date(row.busy_until).getTime() > Date.now()) {
        throw Object.assign(new Error('Another publish operation is already in progress'), { statusCode: 409 });
      }
      await client.query(
        `UPDATE projects
         SET busy_operation = $2,
             busy_until = NOW() + INTERVAL '5 minutes',
             last_activity_at = NOW(),
             state_version = state_version + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [input.projectId, `publish:${pubId}`]
      );
      return row;
    });

    let extractedRootToClean: string | null = null;
    try {
      // 2. Server-side tarball leak scan + extract optional _bionic_meta/ (manifest, bionic.yaml, test results)
      const rawHashRes = await this.db.query<{ sha256: string }>(
        `SELECT d.sha256 FROM data_objects d
         JOIN project_data_grants g ON g.data_object_id = d.id
         WHERE g.project_id = $1 AND d.sha256 <> ''`,
        [input.projectId]
      );
      const preKnownRawHashes = new Set([
        ...rawHashRes.rows.map((r) => r.sha256),
        ...(input.manifestSnapshot?.entries || []).map((e) => e.sha256).filter(Boolean)
      ]);
      const { extractDir } = await this.inspectReportArchive(input.reportTarballBuffer, preKnownRawHashes);
      extractedRootToClean = path.dirname(extractDir);

      let manifestSnapshot = input.manifestSnapshot || {};
      let bionicYaml: Record<string, any> = input.bionicYaml || {};
      let testResults = input.testResults || [];
      let workspaceStats: Record<string, any> | null = null;
      let effectiveTitle = input.title;
      let effectiveSummary = input.summary;
      let effectiveVisibility = input.visibility;
      let effectiveGitCommitSha = input.gitCommitSha;

      const metaDir = path.join(extractDir, '_bionic_meta');
      if (fs.existsSync(metaDir)) {
        const mPath = path.join(metaDir, 'manifest.json');
        if (fs.existsSync(mPath) && !input.manifestSnapshot) {
          try {
            manifestSnapshot = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
          } catch {}
        }
        const byPath = path.join(metaDir, 'bionic.yaml');
        if (fs.existsSync(byPath) && !input.bionicYaml) {
          try {
            const rawYaml = fs.readFileSync(byPath, 'utf-8');
            const parsedYaml = yaml.load(rawYaml, { schema: yaml.JSON_SCHEMA });
            if (parsedYaml && typeof parsedYaml === 'object' && !Array.isArray(parsedYaml)) {
              bionicYaml = { ...(parsedYaml as Record<string, any>), raw: rawYaml };
            }
          } catch {}
        }
        const pmPath = path.join(metaDir, 'publish_meta.json');
        if (fs.existsSync(pmPath)) {
          try {
            const pm = JSON.parse(fs.readFileSync(pmPath, 'utf-8'));
            if (typeof pm?.title === 'string' && pm.title.trim()) {
              effectiveTitle = pm.title.replace(/[\r\n\0]/g, ' ').trim().slice(0, 140);
            }
            if (typeof pm?.summary === 'string' && pm.summary.trim()) {
              effectiveSummary = pm.summary.replace(/\0/g, '').trim().slice(0, 4000);
            }
            if (pm?.visibility === 'private' || pm?.visibility === 'org' || pm?.visibility === 'public') {
              effectiveVisibility = pm.visibility;
            }
            if (typeof pm?.gitCommitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(pm.gitCommitSha.trim())) {
              effectiveGitCommitSha = pm.gitCommitSha.trim();
            }
          } catch {}
        }
        const wsStatsPath = path.join(metaDir, 'workspace_stats.json');
        if (fs.existsSync(wsStatsPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(wsStatsPath, 'utf-8'));
            if (parsed && typeof parsed === 'object') workspaceStats = parsed;
          } catch {}
        }
        const tDir = path.join(metaDir, 'test_results');
        if (fs.existsSync(tDir) && !input.testResults) {
          const collected: any[] = [];
          for (const f of fs.readdirSync(tDir)) {
            if (!f.endsWith('.json')) continue;
            try {
              const parsed = JSON.parse(fs.readFileSync(path.join(tDir, f), 'utf-8'));
              if (Array.isArray(parsed)) collected.push(...parsed);
              else collected.push(parsed);
            } catch {}
          }
          testResults = collected;
        }
        // Strip internal _bionic_meta/ before deploying static site
        fs.rmSync(metaDir, { recursive: true, force: true });
      }

      // Fall back to bionic.yaml summary/title when caller didn't supply one (skipping starter boilerplate)
      const isBoilerplateSummary = (s: string) =>
        s.trim().startsWith('Summarize the research question, data sources, analytical workflow');
      if (!effectiveSummary && typeof bionicYaml?.summary === 'string' && !isBoilerplateSummary(bionicYaml.summary)) {
        effectiveSummary = bionicYaml.summary.trim().slice(0, 4000);
      }

      // 3. Independently validate all manifest dataset grants (Security C4)
      const manifestEntries = manifestSnapshot?.entries || [];
      const pinnedData = await this.storage.assertManifestEntriesAuthorized(input.projectId, manifestEntries);

      // Verify git commit exists in Hub's Git repository (required so "Create Project from Module" always forks full code!)
      if (!effectiveGitCommitSha || effectiveGitCommitSha === 'uncommitted' || !/^[0-9a-f]{7,40}$/i.test(effectiveGitCommitSha)) {
        throw Object.assign(
          new Error('Publish requires a committed and pushed Git snapshot (got uncommitted). Ensure scripts/publish.sh pushes to Hub Git.'),
          { statusCode: 400 }
        );
      }
      const commitExists = await this.git.verifyCommitExists(input.projectId, effectiveGitCommitSha);
      if (!commitExists) {
        throw Object.assign(
          new Error(`Git commit ${effectiveGitCommitSha} not found in Hub project repository. Re-run git push or scripts/publish.sh.`),
          { statusCode: 400 }
        );
      }

      // 4. Compute next publication version & upload to strictly separated public vs private bucket (Security C3)
      const verRes = await this.db.query<{ max_ver: number | null }>(
        `SELECT MAX(version) AS max_ver FROM publications WHERE project_id = $1`,
        [input.projectId]
      );
      const version = (verRes.rows[0]?.max_ver || 0) + 1;
      const bucketKind: 'public' | 'private' = effectiveVisibility === 'public' ? 'public' : 'private';
      const prefix = bucketKind === 'public' ? `reports/${proj.slug}/v${version}` : `publications/${pubId}`;

      const artifactUri = await this.uploadStaticTree(bucketKind, prefix, extractDir, {
        publicationId: pubId,
        projectId: input.projectId,
        projectSlug: proj.slug,
        version,
        gitCommitSha: effectiveGitCommitSha,
        publishedAt: new Date().toISOString()
      });

      const scheme = this.cfg.devMode ? 'http' : 'https';
      const portSuffix = this.cfg.devMode && this.cfg.port !== 80 && this.cfg.port !== 443 ? `:${this.cfg.port}` : '';
      const staticSiteUrl =
        bucketKind === 'public'
          ? `${this.cfg.publicReportsOrigin}/reports/${proj.slug}/v${version}/index.html`
          : `${scheme}://${pubId}.reports.${this.cfg.domain}${portSuffix}/index.html`;

      // 5. Commit immutable publication + normalized publication_data_objects + sync project landing metadata
      await this.db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO publications (
             id, project_id, version, title, summary, git_commit_sha, git_tag,
             template_slug, template_revision_id, storage_bucket_kind, static_site_url,
             artifact_storage_uri, manifest_snapshot_json, bionic_yaml_json, test_results_json,
             visibility, status, published_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, 'ready', $17
           )`,
          [
            pubId,
            input.projectId,
            version,
            effectiveTitle,
            effectiveSummary,
            effectiveGitCommitSha,
            `pub/v${version}`,
            proj.template_slug,
            proj.template_revision_id,
            bucketKind,
            staticSiteUrl,
            artifactUri,
            JSON.stringify(manifestSnapshot),
            JSON.stringify(bionicYaml),
            JSON.stringify(testResults),
            effectiveVisibility,
            input.publishedByUserId
          ]
        );

        for (const item of pinnedData) {
          await client.query(
            `INSERT INTO publication_data_objects (publication_id, data_object_id, gcs_generation, rel_path, sha256)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [pubId, item.dataObjectId, item.gcsGeneration, item.relPath, item.sha256]
          );
        }

        // Keep Project Overview metadata in sync with the newly published snapshot & manifest pointers
        const curProj = await client.query<{ bionic_meta_json: any; description: string }>(
          `SELECT bionic_meta_json, description FROM projects WHERE id = $1`,
          [input.projectId]
        );
        const existingMeta = (curProj.rows[0]?.bionic_meta_json || {}) as Record<string, any>;
        const nextMeta: Record<string, any> = {
          ...existingMeta,
          ...(Object.keys(bionicYaml).length > 0 ? { bionicYaml } : {}),
          ...(workspaceStats?.workspaceDir ? { workspaceDir: workspaceStats.workspaceDir } : {}),
          ...(workspaceStats?.rootFile ? { rootFile: workspaceStats.rootFile } : {}),
          ...(typeof workspaceStats?.fileCount === 'number' ? { fileCount: workspaceStats.fileCount } : {}),
          ...(Array.isArray(workspaceStats?.topLevelItems) ? { topLevelItems: workspaceStats.topLevelItems } : {}),
          manifestEntries: manifestEntries.map((e: any) => ({
            filepath: String(e.filepath || ''),
            sizeBytes: Number(e.sizeBytes || 0),
            sha256: String(e.sha256 || ''),
            uri: e.storage?.uri ? String(e.storage.uri) : undefined
          })),
          latestGitCommitSha: effectiveGitCommitSha,
          lastSavedAt: new Date().toISOString()
        };
        const nextDescription =
          effectiveSummary && !isBoilerplateSummary(effectiveSummary)
            ? effectiveSummary
            : curProj.rows[0]?.description || '';

        await client.query(
          `UPDATE projects
           SET description = $2,
               bionic_meta_json = $3::jsonb,
               workspace_size_bytes = COALESCE($4, workspace_size_bytes),
               last_edited_at = COALESCE($5::timestamptz, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [
            input.projectId,
            nextDescription,
            JSON.stringify(nextMeta),
            typeof workspaceStats?.totalBytes === 'number' ? workspaceStats.totalBytes : null,
            workspaceStats?.lastEditedAt || null
          ]
        );
      });

      this.latestCache.delete(proj.slug);
      return { publicationId: pubId, version, staticSiteUrl, visibility: effectiveVisibility };
    } finally {
      if (extractedRootToClean) {
        fs.rmSync(extractedRootToClean, { recursive: true, force: true });
      }
      await this.db.query(
        `UPDATE projects SET busy_operation = NULL, busy_until = NULL, updated_at = NOW() WHERE id = $1 AND busy_operation = $2`,
        [input.projectId, `publish:${pubId}`]
      );
    }
  }

  private async uploadStaticTree(
    bucketKind: 'public' | 'private',
    prefix: string,
    localDir: string,
    provenanceMeta: Record<string, any>
  ): Promise<string> {
    // Inject lightweight provenance JSON alongside report
    fs.writeFileSync(path.join(localDir, 'bionic-publication.json'), JSON.stringify(provenanceMeta, null, 2));

    const gcsBucket = bucketKind === 'public' ? this.cfg.gcpStaticPublicBucket : this.cfg.gcpStaticPrivateBucket;
    if (gcsBucket) {
      const client = await this.googleAuth.getClient();
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('Failed to get GCS token for static publish');

      const uploadDir = async (dir: string, relBase: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await uploadDir(full, rel);
            continue;
          }
          const objectName = `${prefix}/${rel}`;
          const buf = fs.readFileSync(full);
          const contentType = guessContentType(entry.name);
          const res = await fetch(
            `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(gcsBucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': contentType,
                'Cache-Control': bucketKind === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store'
              },
              body: buf
            }
          );
          if (!res.ok) {
            throw new Error(`GCS static upload failed (${res.status}) for ${objectName}`);
          }
        }
      };
      await uploadDir(localDir, '');
      return `gs://${gcsBucket}/${prefix}`;
    }

    // Local filesystem static storage (dev/test)
    const destRoot = path.join(this.cfg.localStorageDir, bucketKind === 'public' ? 'static-public' : 'static-private', prefix);
    fs.mkdirSync(destRoot, { recursive: true });
    fs.cpSync(localDir, destRoot, { recursive: true });
    return `file://${destRoot}`;
  }

  /**
   * Stateless atomic `/reports/:slug/latest` redirect lookup (H2: GCS lacks native 302 redirects).
   */
  async resolveLatestPublicVersion(projectSlug: string): Promise<number | null> {
    const cached = this.latestCache.get(projectSlug);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.version;
    }
    const res = await this.db.query<{ version: number }>(
      `SELECT pub.version
       FROM publications pub
       JOIN projects p ON p.id = pub.project_id
       WHERE p.slug = $1
         AND pub.visibility = 'public'
         AND pub.status = 'ready'
       ORDER BY pub.version DESC
       LIMIT 1`,
      [projectSlug]
    );
    const ver = res.rows[0]?.version ?? null;
    if (ver !== null) {
      this.latestCache.set(projectSlug, { version: ver, expiresAtMs: Date.now() + 20_000 });
    }
    return ver;
  }

  /**
   * Durable visibility downgrade (`public -> private/org`, C3 + H4):
   * marks `public_purge_pending = TRUE` so reconciler retries GCS purge until verified gone.
   */
  async downgradeVisibility(pubId: string, newVisibility: 'private' | 'org'): Promise<void> {
    const res = await this.db.query(
      `UPDATE publications
       SET visibility = $2,
           storage_bucket_kind = 'private',
           status = 'downgrading',
           public_purge_pending = TRUE,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, project_id, version, artifact_storage_uri`,
      [pubId, newVisibility]
    );
    if (res.rowCount === 0) throw Object.assign(new Error('Publication not found'), { statusCode: 404 });
    // Clear latest redirect cache immediately
    this.latestCache.clear();
  }
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.csv': 'text/csv; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}
