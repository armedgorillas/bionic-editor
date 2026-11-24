import crypto from 'crypto';
import {
  createId,
  parseConfigYaml,
  type ConfigKind,
  type ComputeTemplateConfig,
  type ModelConfig,
  type SkillConfig,
  type McpServerConfig
} from '@bionic/shared';
import type { HubDatabase } from '../db/pool.js';
import type { HubConfig } from '../config.js';
import { assertSafeOutboundUrl } from '../gateways/ssrf.js';

export interface ApplyConfigItem {
  kind: ConfigKind;
  contentYaml: string;
}

export interface ApplyConfigResult {
  dryRun: boolean;
  changes: Array<{
    kind: ConfigKind;
    slug: string;
    action: 'create' | 'update' | 'unchanged';
    version: number;
    revisionId?: string;
    sha256: string;
  }>;
}

export class AdminConfigService {
  constructor(private readonly db: HubDatabase, private readonly cfg: HubConfig) {}

  async applyConfigs(input: {
    items: ApplyConfigItem[];
    actor: string;
    gitCommitSha?: string;
    gitRepo?: string;
    dryRun?: boolean;
  }): Promise<ApplyConfigResult> {
    // 1. Validate EVERY item up front (atomic all-or-nothing)
    const validated: Array<{
      kind: ConfigKind;
      slug: string;
      parsed: ComputeTemplateConfig | ModelConfig | SkillConfig | McpServerConfig;
      contentYaml: string;
      sha256: string;
    }> = [];

    for (const item of input.items) {
      const parsed = parseConfigYaml(item.kind, item.contentYaml);
      const slug = parsed.metadata.slug;

      // Additional security policy gates
      if (item.kind === 'template') {
        const tmpl = parsed as ComputeTemplateConfig;
        if (
          this.cfg.allowlistedTemplateSAs.size > 0 &&
          !this.cfg.allowlistedTemplateSAs.has(tmpl.iam.serviceAccountEmail)
        ) {
          throw new Error(
            `Security policy violation: template "${slug}" serviceAccountEmail "${tmpl.iam.serviceAccountEmail}" is not in HUB_ALLOWLISTED_SAS`
          );
        }
      }

      if (item.kind === 'mcp') {
        const mcp = parsed as McpServerConfig;
        if (mcp.spec.routing === 'hub_gateway' && mcp.spec.url) {
          await assertSafeOutboundUrl(mcp.spec.url, {
            allowHttp: this.cfg.devMode,
            allowedPrivateCidrs: this.cfg.allowedPrivateCidrs,
            blockedCidrs: this.cfg.blockedCidrs
          });
        }
      }

      if (item.kind === 'model') {
        const model = parsed as ModelConfig;
        if (model.spec.baseUrl) {
          await assertSafeOutboundUrl(model.spec.baseUrl, {
            allowHttp: this.cfg.devMode,
            allowedPrivateCidrs: this.cfg.allowedPrivateCidrs,
            blockedCidrs: this.cfg.blockedCidrs
          });
        }
      }

      const sha256 = crypto.createHash('sha256').update(item.contentYaml).digest('hex');
      validated.push({ kind: item.kind, slug, parsed, contentYaml: item.contentYaml, sha256 });
    }

    const dryRun = Boolean(input.dryRun);
    const changes: ApplyConfigResult['changes'] = [];

    await this.db.withTransaction(async (client) => {
      for (const v of validated) {
        const latestRes = await client.query(
          `SELECT id, version, content_sha256 FROM config_revisions
           WHERE kind = $1 AND slug = $2 ORDER BY version DESC LIMIT 1`,
          [v.kind, v.slug]
        );
        const latest = latestRes.rows[0];

        if (latest && latest.content_sha256 === v.sha256) {
          changes.push({
            kind: v.kind,
            slug: v.slug,
            action: 'unchanged',
            version: latest.version,
            revisionId: latest.id,
            sha256: v.sha256
          });
          continue;
        }

        const nextVersion = latest ? latest.version + 1 : 1;
        const action = latest ? 'update' : 'create';
        const revId = createId('rev');

        if (dryRun) {
          changes.push({ kind: v.kind, slug: v.slug, action, version: nextVersion, sha256: v.sha256 });
          continue;
        }

        await client.query(
          `INSERT INTO config_revisions (id, kind, slug, version, content_yaml, parsed_json, content_sha256, git_commit_sha, git_repo, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'active', $10)`,
          [
            revId,
            v.kind,
            v.slug,
            nextVersion,
            v.contentYaml,
            JSON.stringify(v.parsed),
            v.sha256,
            input.gitCommitSha || null,
            input.gitRepo || null,
            input.actor
          ]
        );

        // Upsert pointer table
        if (v.kind === 'template') {
          const t = v.parsed as ComputeTemplateConfig;
          await client.query(
            `INSERT INTO templates (slug, active_revision_id, display_name, description, allowed_group_ids, default_idle_timeout_min, max_idle_timeout_min, allowlisted_sa_email, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (slug) DO UPDATE SET
               active_revision_id = EXCLUDED.active_revision_id,
               display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               allowed_group_ids = EXCLUDED.allowed_group_ids,
               default_idle_timeout_min = EXCLUDED.default_idle_timeout_min,
               max_idle_timeout_min = EXCLUDED.max_idle_timeout_min,
               allowlisted_sa_email = EXCLUDED.allowlisted_sa_email,
               updated_at = NOW()`,
            [
              v.slug,
              revId,
              t.metadata.displayName,
              t.metadata.description,
              t.metadata.allowedGroups,
              t.compute.idleTimeoutDefaultMinutes,
              t.compute.idleTimeoutMaxMinutes,
              t.iam.serviceAccountEmail
            ]
          );
        } else if (v.kind === 'model') {
          const m = v.parsed as ModelConfig;
          await client.query(
            `INSERT INTO models (slug, active_revision_id, provider_type, protocol, display_name, allowed_group_ids, enabled, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (slug) DO UPDATE SET
               active_revision_id = EXCLUDED.active_revision_id,
               provider_type = EXCLUDED.provider_type,
               protocol = EXCLUDED.protocol,
               display_name = EXCLUDED.display_name,
               allowed_group_ids = EXCLUDED.allowed_group_ids,
               enabled = EXCLUDED.enabled,
               updated_at = NOW()`,
            [
              v.slug,
              revId,
              m.spec.provider,
              m.spec.protocol,
              m.metadata.displayName,
              m.metadata.allowedGroups,
              m.metadata.enabled
            ]
          );
        } else if (v.kind === 'skill') {
          const s = v.parsed as SkillConfig;
          await client.query(
            `INSERT INTO skills (slug, active_revision_id, display_name, description, bundle_sha256, allowed_group_ids, enabled, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (slug) DO UPDATE SET
               active_revision_id = EXCLUDED.active_revision_id,
               display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               bundle_sha256 = EXCLUDED.bundle_sha256,
               allowed_group_ids = EXCLUDED.allowed_group_ids,
               enabled = EXCLUDED.enabled,
               updated_at = NOW()`,
            [
              v.slug,
              revId,
              s.metadata.displayName,
              s.metadata.description,
              v.sha256,
              s.metadata.allowedGroups,
              s.metadata.enabled
            ]
          );
        } else if (v.kind === 'mcp') {
          const mc = v.parsed as McpServerConfig;
          await client.query(
            `INSERT INTO mcp_servers (slug, active_revision_id, transport, routing, allowed_group_ids, enabled, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (slug) DO UPDATE SET
               active_revision_id = EXCLUDED.active_revision_id,
               transport = EXCLUDED.transport,
               routing = EXCLUDED.routing,
               allowed_group_ids = EXCLUDED.allowed_group_ids,
               enabled = EXCLUDED.enabled,
               updated_at = NOW()`,
            [
              v.slug,
              revId,
              mc.spec.transport,
              mc.spec.routing,
              mc.metadata.allowedGroups,
              mc.metadata.enabled
            ]
          );
        }

        changes.push({ kind: v.kind, slug: v.slug, action, version: nextVersion, revisionId: revId, sha256: v.sha256 });
      }
    });

    if (!dryRun && changes.some((c) => c.action !== 'unchanged')) {
      await this.db.notify('config_updated', {
        kinds: Array.from(new Set(changes.filter((c) => c.action !== 'unchanged').map((c) => c.kind)))
      });
    }

    return { dryRun, changes };
  }

  async rollbackConfig(kind: ConfigKind, slug: string, targetVersion: number): Promise<{ revisionId: string; version: number }> {
    return this.db.withTransaction(async (client) => {
      const revRes = await client.query(
        `SELECT id, version, parsed_json, content_sha256 FROM config_revisions WHERE kind = $1 AND slug = $2 AND version = $3`,
        [kind, slug, targetVersion]
      );
      const rev = revRes.rows[0];
      if (!rev) {
        throw new Error(`Revision not found: ${kind}/${slug}@v${targetVersion}`);
      }

      // Security #19: Sync ALL denormalized RBAC/enabled/policy columns from the target revision!
      if (kind === 'template') {
        const t = rev.parsed_json as ComputeTemplateConfig;
        if (this.cfg.allowlistedTemplateSAs.size > 0 && !this.cfg.allowlistedTemplateSAs.has(t.iam.serviceAccountEmail)) {
          throw new Error(`Rollback blocked: SA ${t.iam.serviceAccountEmail} is no longer allowlisted`);
        }
        await client.query(
          `UPDATE templates
           SET active_revision_id = $1, display_name = $2, description = $3, allowed_group_ids = $4,
               default_idle_timeout_min = $5, max_idle_timeout_min = $6, allowlisted_sa_email = $7, updated_at = NOW()
           WHERE slug = $8`,
          [
            rev.id, t.metadata.displayName, t.metadata.description, t.metadata.allowedGroups,
            t.compute.idleTimeoutDefaultMinutes, t.compute.idleTimeoutMaxMinutes, t.iam.serviceAccountEmail, slug
          ]
        );
      } else if (kind === 'model') {
        const m = rev.parsed_json as ModelConfig;
        await client.query(
          `UPDATE models
           SET active_revision_id = $1, provider_type = $2, protocol = $3, display_name = $4,
               allowed_group_ids = $5, enabled = $6, updated_at = NOW()
           WHERE slug = $7`,
          [rev.id, m.spec.provider, m.spec.protocol, m.metadata.displayName, m.metadata.allowedGroups, m.metadata.enabled, slug]
        );
      } else if (kind === 'skill') {
        const s = rev.parsed_json as SkillConfig;
        await client.query(
          `UPDATE skills
           SET active_revision_id = $1, display_name = $2, description = $3, bundle_sha256 = $4,
               allowed_group_ids = $5, enabled = $6, updated_at = NOW()
           WHERE slug = $7`,
          [rev.id, s.metadata.displayName, s.metadata.description, rev.content_sha256, s.metadata.allowedGroups, s.metadata.enabled, slug]
        );
      } else if (kind === 'mcp') {
        const mc = rev.parsed_json as McpServerConfig;
        await client.query(
          `UPDATE mcp_servers
           SET active_revision_id = $1, transport = $2, routing = $3, allowed_group_ids = $4,
               enabled = $5, updated_at = NOW()
           WHERE slug = $6`,
          [rev.id, mc.spec.transport, mc.spec.routing, mc.metadata.allowedGroups, mc.metadata.enabled, slug]
        );
      }

      await this.db.notify('config_updated', { kinds: [kind], slug, version: targetVersion });
      return { revisionId: rev.id, version: targetVersion };
    });
  }

  async listActiveConfigs(kind: ConfigKind): Promise<any[]> {
    const tableMap: Record<ConfigKind, string> = {
      template: 'templates',
      model: 'models',
      skill: 'skills',
      mcp: 'mcp_servers'
    };
    const res = await this.db.query(
      `SELECT t.*, r.version, r.parsed_json, r.content_sha256, r.git_commit_sha, r.created_by, r.created_at AS revision_created_at
       FROM ${tableMap[kind]} t
       JOIN config_revisions r ON r.id = t.active_revision_id
       ORDER BY t.slug ASC`
    );
    return res.rows;
  }

  /**
   * Returns all GCE Packer image self-links referenced by active templates, non-deleted projects,
   * or ready publications so CI Packer pruning never deletes an in-use VM image.
   */
  async getImagesInUse(): Promise<string[]> {
    const res = await this.db.query<{ image: string }>(`
      SELECT DISTINCT r.parsed_json->'compute'->>'image' AS image
      FROM config_revisions r
      WHERE r.kind = 'template'
        AND (
          r.id IN (SELECT active_revision_id FROM templates)
          OR r.id IN (SELECT template_revision_id FROM projects WHERE status <> 'deleted')
          OR r.id IN (SELECT template_revision_id FROM publications WHERE status <> 'deleted')
        )
        AND r.parsed_json->'compute'->>'image' IS NOT NULL
    `);
    return res.rows.map((r) => r.image);
  }
}
