import {
  createId,
  slugify,
  assertValidTransition,
  buildWakeIdempotencyKey,
  type ComputeTemplateConfig,
  type ProjectStatus
} from '@bionic/shared';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';
import { enqueueJob } from '../db/jobs.js';
import type { ComputeProvider } from '../compute/provider.js';
import type { GitProvider } from '../gateways/git/proxy.js';
import type { AuthenticatedUser } from '../auth/sessions.js';

export class ProjectOrchestrator {
  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly compute: ComputeProvider,
    private readonly git: GitProvider
  ) {}

  async createProject(input: {
    user: AuthenticatedUser;
    name: string;
    description?: string;
    templateSlug?: string;
    idleTimeoutMinutes?: number;
    fromPublicationId?: string;
  }): Promise<{ id: string; slug: string; status: ProjectStatus }> {
    const projectId = createId('prj');
    const baseSlug = slugify(input.name);
    const slug = `${baseSlug}-${projectId.slice(-6)}`;

    let templateSlug = input.templateSlug || '';
    let templateRevId = '';
    let templateConfig!: ComputeTemplateConfig;
    let parentProjectId: string | null = null;
    let parentPublicationId: string | null = null;
    let forkedCommitSha: string | null = null;
    let pinnedDataIds: string[] = [];

    // If creating from a completed analysis module ("Fork"), verify read access & pin datasets
    if (input.fromPublicationId) {
      const pubRes = await this.db.query(
        `SELECT pub.id, pub.project_id, pub.git_commit_sha, pub.template_slug, pub.template_revision_id,
                pub.visibility, pub.published_by, pm.role AS member_role
         FROM publications pub
         LEFT JOIN project_members pm ON pm.project_id = pub.project_id AND pm.user_id = $2
         WHERE pub.id = $1 AND pub.status = 'ready'`,
        [input.fromPublicationId, input.user.id]
      );
      const pub = pubRes.rows[0];
      if (!pub) throw Object.assign(new Error('Source completed module not found'), { statusCode: 404 });
      if (pub.visibility === 'private' && !pub.member_role && input.user.role !== 'admin') {
        throw Object.assign(new Error('Not authorized to fork this private publication'), { statusCode: 403 });
      }
      parentProjectId = pub.project_id;
      parentPublicationId = pub.id;
      forkedCommitSha = pub.git_commit_sha;
      if (!templateSlug) {
        templateSlug = pub.template_slug;
        templateRevId = pub.template_revision_id;
      }

      const dataRes = await this.db.query<{ data_object_id: string }>(
        `SELECT data_object_id FROM publication_data_objects WHERE publication_id = $1`,
        [pub.id]
      );
      pinnedDataIds = dataRes.rows.map((r) => r.data_object_id);
    }

    if (!templateSlug) {
      throw Object.assign(new Error('templateSlug is required'), { statusCode: 400 });
    }

    // Load template & enforce allowedGroups RBAC
    const tmplRes = await this.db.query(
      `SELECT t.slug, t.active_revision_id, t.allowed_group_ids, t.default_idle_timeout_min, t.max_idle_timeout_min,
              r.parsed_json
       FROM templates t
       JOIN config_revisions r ON r.id = COALESCE($2, t.active_revision_id)
       WHERE t.slug = $1`,
      [templateSlug, templateRevId || null]
    );
    const tmplRow = tmplRes.rows[0];
    if (!tmplRow) {
      throw Object.assign(new Error(`Template "${templateSlug}" not found`), { statusCode: 404 });
    }
    const allowedGroups: string[] = tmplRow.allowed_group_ids || [];
    const permitted =
      input.user.role === 'admin' ||
      input.user.groupSlugs.includes('admins') ||
      allowedGroups.some((g) => input.user.groupSlugs.includes(g));
    if (!permitted) {
      throw Object.assign(new Error(`Not authorized to use template "${templateSlug}"`), { statusCode: 403 });
    }

    templateRevId = templateRevId || tmplRow.active_revision_id;
    templateConfig = tmplRow.parsed_json as ComputeTemplateConfig;
    const idleTimeout = Math.max(
      5,
      Math.min(
        input.idleTimeoutMinutes ?? tmplRow.default_idle_timeout_min ?? 20,
        tmplRow.max_idle_timeout_min ?? 180
      )
    );

    const gitRepoRef = await this.git.ensureProjectRepo(
      projectId,
      parentProjectId && forkedCommitSha ? { sourceProjectId: parentProjectId, commitSha: forkedCommitSha } : undefined
    );

    const zone = templateConfig.compute.zone || this.cfg.gcpDefaultZone;
    // Crash-safe deterministic GCE names persisted BEFORE calling instances.insert (H1)
    const instanceName = projectId;
    const diskName = `pd-${projectId}`;

    await this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO projects (
           id, slug, name, description, owner_id, template_slug, template_revision_id,
           parent_project_id, parent_publication_id, forked_from_commit_sha, git_repo_ref,
           status, desired_state, transition_started_at,
           compute_provider, compute_zone, compute_instance_name, compute_disk_name, compute_disk_size_gb,
           idle_timeout_minutes, data_bucket_prefix
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11,
           'provisioning', 'running', NOW(),
           $12, $13, $14, $15, $16,
           $17, $18
         )`,
        [
          projectId,
          slug,
          input.name,
          input.description || '',
          input.user.id,
          templateSlug,
          templateRevId,
          parentProjectId,
          parentPublicationId,
          forkedCommitSha,
          gitRepoRef,
          this.compute.kind,
          zone,
          instanceName,
          diskName,
          templateConfig.compute.workspaceDiskGb,
          idleTimeout,
          `projects/${projectId}/blobs/`
        ]
      );

      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [projectId, input.user.id]
      );

      // Copy read-only dataset grants strictly from publication_data_objects (Security C4)
      for (const dataObjId of pinnedDataIds) {
        await client.query(
          `INSERT INTO project_data_grants (project_id, data_object_id, permission, granted_via)
           VALUES ($1, $2, 'read', 'fork')
           ON CONFLICT DO NOTHING`,
          [projectId, dataObjId]
        );
      }

      await enqueueJob(client, {
        queue: 'compute',
        jobType: 'provision_project',
        payload: { projectId },
        idempotencyKey: `provision:${projectId}:v1`
      });
    });

    await this.db.notify('project_state_changes', { projectId, status: 'provisioning' });
    return { id: projectId, slug, status: 'provisioning' };
  }

  /**
   * Thundering-herd-safe idempotent wake (H1):
   * Uses SELECT ... FOR UPDATE + versioned idempotency key `wake:<prj-id>:v<state_version>`.
   */
  async requestWakeProject(projectId: string): Promise<{ status: ProjectStatus; enqueued: boolean }> {
    const result = await this.db.withTransaction(async (client) => {
      const res = await client.query<{ status: ProjectStatus; state_version: number }>(
        `SELECT status, state_version FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId]
      );
      const row = res.rows[0];
      if (!row) throw Object.assign(new Error('Project not found'), { statusCode: 404 });

      if (row.status === 'running' || row.status === 'resuming' || row.status === 'starting' || row.status === 'provisioning') {
        return { status: row.status, enqueued: false };
      }

      const nextStatus: ProjectStatus =
        row.status === 'frozen' ? 'resuming' : row.status === 'archived' ? 'provisioning' : 'starting';
      assertValidTransition(row.status, nextStatus);

      const nextVer = row.state_version + 1;
      await client.query(
        `UPDATE projects
         SET status = $2,
             desired_state = 'running',
             state_version = $3,
             transition_started_at = NOW(),
             last_activity_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [projectId, nextStatus, nextVer]
      );

      const jobType =
        row.status === 'frozen' ? 'resume_project' : row.status === 'archived' ? 'provision_project' : 'start_project';
      const jobId = await enqueueJob(client, {
        queue: 'compute',
        jobType,
        payload: { projectId, expectedStateVersion: nextVer },
        idempotencyKey: buildWakeIdempotencyKey(projectId, nextVer)
      });

      return { status: nextStatus, enqueued: Boolean(jobId) };
    });

    if (result.enqueued) {
      await this.db.notify('project_state_changes', { projectId, status: result.status });
    }
    return result;
  }

  async requestTransition(projectId: string, action: 'freeze' | 'stop' | 'delete'): Promise<{ status: ProjectStatus }> {
    const targetMap: Record<'freeze' | 'stop' | 'delete', { status: ProjectStatus; desired: string; jobType: string }> = {
      freeze: { status: 'freezing', desired: 'frozen', jobType: 'freeze_project' },
      stop: { status: 'stopping', desired: 'stopped', jobType: 'stop_project' },
      delete: { status: 'deleting', desired: 'deleted', jobType: 'delete_project' }
    };
    const target = targetMap[action];

    const nextVer = await this.db.withTransaction(async (client) => {
      const res = await client.query<{ status: ProjectStatus; state_version: number; busy_until: string | null }>(
        `SELECT status, state_version, busy_until FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId]
      );
      const row = res.rows[0];
      if (!row) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      if (action !== 'delete' && row.busy_until && new Date(row.busy_until).getTime() > Date.now()) {
        throw Object.assign(new Error('Project has an active publish operation; cannot freeze/stop right now'), {
          statusCode: 409
        });
      }
      assertValidTransition(row.status, target.status);
      const ver = row.state_version + 1;

      await client.query(
        `UPDATE projects
         SET status = $2,
             desired_state = $3,
             state_version = $4,
             transition_started_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [projectId, target.status, target.desired, ver]
      );

      await enqueueJob(client, {
        queue: 'compute',
        jobType: target.jobType,
        payload: { projectId, expectedStateVersion: ver },
        idempotencyKey: `${action}:${projectId}:v${ver}`
      });
      return ver;
    });

    await this.db.notify('project_state_changes', { projectId, status: target.status, stateVersion: nextVer });
    return { status: target.status };
  }

  /**
   * Triggers a 3-phase zero-egress headless reproduction run of a self-contained analysis module (§9.4).
   */
  async triggerReproRun(input: {
    user: AuthenticatedUser;
    publicationId: string;
    maxDurationSec?: number;
  }): Promise<{ runId: string; status: string }> {
    if (input.user.role === 'viewer') {
      throw Object.assign(new Error('Viewers cannot trigger headless compute runs'), { statusCode: 403 });
    }
    const pubRes = await this.db.query(
      `SELECT pub.id, pub.project_id, pub.git_commit_sha, pub.template_slug, pub.template_revision_id,
              pub.visibility, pm.role AS member_role, t.allowed_group_ids
       FROM publications pub
       JOIN templates t ON t.slug = pub.template_slug
       LEFT JOIN project_members pm ON pm.project_id = pub.project_id AND pm.user_id = $2
       WHERE pub.id = $1 AND pub.status = 'ready'`,
      [input.publicationId, input.user.id]
    );
    const pub = pubRes.rows[0];
    if (!pub) throw Object.assign(new Error('Completed analysis module not found'), { statusCode: 404 });

    if (pub.visibility === 'private' && !pub.member_role && input.user.role !== 'admin') {
      throw Object.assign(new Error('Not authorized to reproduce this private publication'), { statusCode: 403 });
    }

    const allowedGroups: string[] = pub.allowed_group_ids || [];
    const templateAllowed =
      input.user.role === 'admin' ||
      input.user.groupSlugs.includes('admins') ||
      allowedGroups.some((g) => input.user.groupSlugs.includes(g));
    if (!templateAllowed && !this.cfg.runnerNoIamSaEmail) {
      throw Object.assign(new Error(`Not authorized to run template "${pub.template_slug}"`), { statusCode: 403 });
    }

    // Per-user concurrent run cap (prevent runaway compute costs)
    const activeRuns = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM runs
       WHERE triggered_by = $1 AND status IN ('queued', 'building_env', 'hydrating', 'running', 'publishing')`,
      [input.user.id]
    );
    if (Number(activeRuns.rows[0]?.cnt || 0) >= 3) {
      throw Object.assign(new Error('Maximum 3 concurrent reproduction runs per user'), { statusCode: 429 });
    }

    const runId = createId('run');
    const maxDuration = Math.max(60, Math.min(input.maxDurationSec ?? 3600, 7200));

    await this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO runs (
           id, publication_id, source_project_id, git_commit_sha,
           template_slug, template_revision_id, status, compute_instance_name,
           max_duration_sec, triggered_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9)`,
        [
          runId,
          pub.id,
          pub.project_id,
          pub.git_commit_sha,
          pub.template_slug,
          pub.template_revision_id,
          runId,
          maxDuration,
          input.user.id
        ]
      );
      await enqueueJob(client, {
        queue: 'runs',
        jobType: 'execute_repro_run',
        payload: { runId, useNoIamSa: !templateAllowed },
        idempotencyKey: `run:${runId}`
      });
    });

    return { runId, status: 'queued' };
  }
}
