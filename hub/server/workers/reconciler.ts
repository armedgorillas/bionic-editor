import https from 'https';
import type { ComputeTemplateConfig } from '@bionic/shared';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';
import { claimNextJob, completeJob, failJob, type QueuedJob } from '../db/jobs.js';
import type { ComputeProvider } from '../compute/provider.js';
import type { HubCertificateAuthority } from '../auth/ca.js';
import { extractSpiffeSanFromPeerCert } from '../auth/ca.js';

/**
 * Background Worker & Reconciler Engine (zero Redis — Postgres SKIP LOCKED):
 * 1. Compute job executor (provision, resume, start, freeze w/ CAS guard, stop, delete)
 * 2. 60-second Stuck-Transition State Reconciler
 * 3. Whole-UID Idle Reaper + 7-day FROZEN -> STOPPED auto-demotion
 * 4. 15-minute-grace GCP Orphan Sweeper
 * 5. Daily DB housekeeping & stale LLM spend reservation expiry
 */
export class HubWorkerEngine {
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;
  private readonly workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly compute: ComputeProvider,
    private readonly ca: HubCertificateAuthority
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const addTimer = (fn: () => Promise<void>, intervalMs: number) => {
      const t = setInterval(() => {
        if (!this.running) return;
        fn().catch((err) => console.error(`[HubWorker] background error:`, err.message));
      }, intervalMs);
      t.unref();
      this.timers.push(t);
    };

    addTimer(() => this.pollComputeQueue(), 2_000);
    addTimer(() => this.pollRunsQueue(), 3_000);
    addTimer(() => this.reconcileStuckTransitions(), 60_000);
    addTimer(() => this.runIdleReaper(), 60_000);
    addTimer(() => this.sweepOrphanResources(), 15 * 60_000);
    addTimer(() => this.runHousekeeping(), 60 * 60_000);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  private async callVmInternalApi(
    projectId: string,
    internalIp: string,
    method: 'GET' | 'POST',
    endpointPath: string,
    body?: any
  ): Promise<any> {
    if (this.compute.kind === 'local' && process.env.HUB_LOCAL_SKIP_DAEMON_CALLS !== 'false') {
      return { ready: true, activeAgentTurns: 0, activeSubagents: 0, activeComputeProcs: 0, activeDataTransfers: 0 };
    }
    const creds = this.ca.getHubClientCredentials();
    const expectedSan = `spiffe://bionic/project/${projectId}`;

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          host: internalIp,
          port: 3002,
          path: endpointPath,
          method,
          key: creds.keyPem,
          cert: creds.certPem,
          ca: creds.caCertPem,
          rejectUnauthorized: true,
          timeout: 15_000,
          checkServerIdentity: (_host, peerCert) => {
            const san = extractSpiffeSanFromPeerCert(peerCert);
            if (san !== expectedSan) {
              return new Error(`mTLS SAN mismatch: expected ${expectedSan}, got ${san}`);
            }
            return undefined;
          },
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : undefined
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if ((res.statusCode || 500) >= 400) {
              return reject(new Error(`VM internal API ${endpointPath} returned ${res.statusCode}: ${raw}`));
            }
            try {
              resolve(raw ? JSON.parse(raw) : {});
            } catch {
              resolve({ raw });
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`VM internal API timeout: ${endpointPath}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async pollComputeQueue(): Promise<void> {
    const job = await claimNextJob(this.db, 'compute', this.workerId, 180);
    if (!job) return;
    try {
      await this.executeComputeJob(job);
      await completeJob(this.db, job.id);
    } catch (err: any) {
      await failJob(this.db, job, err.message || String(err));
    }
  }

  async executeComputeJob(job: QueuedJob): Promise<void> {
    const projectId = String(job.payload_json.projectId || '');
    const projRes = await this.db.query(
      `SELECT p.*, r.parsed_json AS template_json
       FROM projects p
       JOIN config_revisions r ON r.id = p.template_revision_id
       WHERE p.id = $1`,
      [projectId]
    );
    const proj = projRes.rows[0];
    if (!proj) return;
    const tmpl = proj.template_json as ComputeTemplateConfig;
    const zone = proj.compute_zone || this.cfg.gcpDefaultZone;

    if (job.job_type === 'provision_project') {
      const op = await this.compute.createInstance({
        instanceName: proj.compute_instance_name || projectId,
        diskName: proj.compute_disk_name || `pd-${projectId}`,
        zone,
        imageSelfLink: tmpl.compute.image,
        machineType: tmpl.compute.machineType,
        bootDiskGb: tmpl.compute.bootDiskGb,
        workspaceDiskGb: tmpl.compute.workspaceDiskGb,
        workspaceDiskType: tmpl.compute.workspaceDiskType,
        subnetName: this.cfg.gcpEditorSubnet,
        serviceAccountEmail: tmpl.iam.serviceAccountEmail,
        restoreSnapshotName: proj.compute_snapshot_name || undefined,
        labels: {
          'bionic-managed': 'true',
          'bionic-hub-id': this.cfg.hubId,
          'bionic-project-id': projectId
        },
        hubOrigin: this.cfg.hubOrigin,
        projectId,
        isFork: Boolean(proj.parent_publication_id || proj.parent_project_id)
      });

      const nextStatus = this.compute.kind === 'local' ? 'running' : 'starting';
      await this.db.query(
        `UPDATE projects
         SET pending_gcp_operation_id = $2,
             compute_instance_id = COALESCE($3, compute_instance_id),
             compute_internal_ip = COALESCE($4, compute_internal_ip),
             status = $5,
             status_message = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [projectId, op.operationId, op.instanceId || null, op.internalIp || null, nextStatus]
      );
      await this.db.notify('project_state_changes', { projectId, status: nextStatus });
      return;
    }

    if (job.job_type === 'resume_project' || job.job_type === 'start_project') {
      const op =
        job.job_type === 'resume_project'
          ? await this.compute.resumeInstance(zone, proj.compute_instance_name)
          : await this.compute.startInstance(zone, proj.compute_instance_name);

      const info = await this.compute.getInstance(zone, proj.compute_instance_name);
      await this.db.query(
        `UPDATE projects
         SET pending_gcp_operation_id = $2,
             compute_internal_ip = COALESCE($3, compute_internal_ip),
             updated_at = NOW()
         WHERE id = $1`,
        [projectId, op.operationId, info?.internalIp || null]
      );

      // In local mode, complete wake immediately; on GCP, VM re-attests via /api/internal/vm/attest
      // (breaking the multi-day freeze mTLS deadlock, C1!) and triggers post-resume -> running.
      if (this.compute.kind === 'local') {
        await this.db.query(
          `UPDATE projects SET status = 'running', pending_gcp_operation_id = NULL, last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [projectId]
        );
        await this.db.notify('project_state_changes', { projectId, status: 'running' });
      }
      return;
    }

    if (job.job_type === 'freeze_project' || job.job_type === 'stop_project') {
      // Best-effort 15-second prepare-freeze hook
      if (proj.compute_internal_ip) {
        try {
          await this.callVmInternalApi(projectId, proj.compute_internal_ip, 'POST', '/api/internal/prepare-freeze', {});
        } catch {
          // Never allow prepare-freeze errors to block idle spindown
        }
      }

      // CAS re-check after prepare-freeze (C4): abort if user activity/publish bumped state_version!
      const expectedVer = Number(job.payload_json.expectedStateVersion || proj.state_version);
      const casRes = await this.db.query(
        `SELECT state_version FROM projects WHERE id = $1 AND status IN ('freezing', 'stopping') AND state_version = $2`,
        [projectId, expectedVer]
      );
      if (casRes.rowCount === 0) {
        return; // Aborted cleanly because user resumed or started publish
      }

      const useSuspend = job.job_type === 'freeze_project' && tmpl.compute.suspendSupported;
      const op = useSuspend
        ? await this.compute.suspendInstance(zone, proj.compute_instance_name)
        : await this.compute.stopInstance(zone, proj.compute_instance_name);
      const finalStatus = useSuspend ? 'frozen' : 'stopped';

      await this.db.query(
        `UPDATE projects
         SET status = $2,
             pending_gcp_operation_id = $3,
             frozen_at = CASE WHEN $2 = 'frozen' THEN NOW() ELSE frozen_at END,
             stopped_at = CASE WHEN $2 = 'stopped' THEN NOW() ELSE stopped_at END,
             updated_at = NOW()
         WHERE id = $1`,
        [projectId, finalStatus, op.operationId]
      );
      await this.db.notify('project_state_changes', { projectId, status: finalStatus });
      return;
    }

    if (job.job_type === 'delete_project') {
      await this.compute.deleteInstance(zone, proj.compute_instance_name, true, proj.compute_disk_name);
      await this.db.query(
        `UPDATE projects SET status = 'deleted', pending_gcp_operation_id = NULL, updated_at = NOW() WHERE id = $1`,
        [projectId]
      );
      await this.db.notify('project_state_changes', { projectId, status: 'deleted' });
    }
  }

  /**
   * 3-Phase Zero-NAT Reproducible Module Runner executor (§9.4).
   */
  async pollRunsQueue(): Promise<void> {
    const job = await claimNextJob(this.db, 'runs', this.workerId, 300);
    if (!job) return;
    const runId = String(job.payload_json.runId || '');
    try {
      const runRes = await this.db.query(
        `SELECT r.*, rev.parsed_json AS template_json
         FROM runs r
         JOIN config_revisions rev ON rev.id = r.template_revision_id
         WHERE r.id = $1`,
        [runId]
      );
      const run = runRes.rows[0];
      if (!run || run.status === 'cancelled') {
        await completeJob(this.db, job.id);
        return;
      }
      const tmpl = run.template_json as ComputeTemplateConfig;
      const saEmail = job.payload_json.useNoIamSa && this.cfg.runnerNoIamSaEmail
        ? this.cfg.runnerNoIamSaEmail
        : tmpl.iam.serviceAccountEmail;

      await this.db.query(`UPDATE runs SET status = 'building_env', started_at = NOW() WHERE id = $1`, [runId]);
      const op = await this.compute.createInstance({
        instanceName: runId,
        diskName: `pd-${runId}`,
        zone: tmpl.compute.zone || this.cfg.gcpDefaultZone,
        imageSelfLink: tmpl.compute.image,
        machineType: tmpl.compute.machineType,
        bootDiskGb: tmpl.compute.bootDiskGb,
        workspaceDiskGb: 50,
        workspaceDiskType: 'pd-balanced',
        // Zero Cloud NAT subnet from boot (C3)!
        subnetName: this.cfg.gcpRunnerSubnet,
        networkTags: ['bionic-runner-noegress'],
        serviceAccountEmail: saEmail,
        maxRunDurationSec: run.max_duration_sec,
        labels: {
          'bionic-managed': 'true',
          'bionic-hub-id': this.cfg.hubId,
          'bionic-run-id': runId
        },
        hubOrigin: this.cfg.hubOrigin,
        projectId: run.source_project_id,
        runId
      });

      await this.db.query(`UPDATE runs SET pending_gcp_operation_id = $2 WHERE id = $1`, [runId, op.operationId]);
      if (this.compute.kind === 'local') {
        await this.db.query(`UPDATE runs SET status = 'succeeded', completed_at = NOW() WHERE id = $1`, [runId]);
        await this.compute.deleteInstance(this.cfg.gcpDefaultZone, runId, true, `pd-${runId}`);
      }
      await completeJob(this.db, job.id);
    } catch (err: any) {
      await this.db.query(`UPDATE runs SET status = 'failed', completed_at = NOW() WHERE id = $1`, [runId]);
      await failJob(this.db, job, err.message || String(err));
    }
  }

  /**
   * 60-second State Reconciler: recovers transitional states stuck > 3 minutes after crashes (H1).
   */
  async reconcileStuckTransitions(): Promise<void> {
    const stuckRes = await this.db.query(
      `SELECT id, status, compute_zone, compute_instance_name, pending_gcp_operation_id
       FROM projects
       WHERE status IN ('creating', 'provisioning', 'starting', 'freezing', 'stopping', 'resuming', 'archiving', 'deleting')
         AND transition_started_at < NOW() - INTERVAL '3 minutes'`
    );
    for (const row of stuckRes.rows) {
      const zone = row.compute_zone || this.cfg.gcpDefaultZone;
      const inst = await this.compute.getInstance(zone, row.compute_instance_name);
      if (row.status === 'deleting' && !inst) {
        await this.db.query(`UPDATE projects SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [row.id]);
        await this.db.notify('project_state_changes', { projectId: row.id, status: 'deleted' });
      } else if (row.status === 'freezing' && inst?.status === 'SUSPENDED') {
        await this.db.query(`UPDATE projects SET status = 'frozen', frozen_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
        await this.db.notify('project_state_changes', { projectId: row.id, status: 'frozen' });
      } else if (row.status === 'stopping' && inst?.status === 'TERMINATED') {
        await this.db.query(`UPDATE projects SET status = 'stopped', stopped_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
        await this.db.notify('project_state_changes', { projectId: row.id, status: 'stopped' });
      } else if (row.pending_gcp_operation_id) {
        const opStatus = await this.compute.getOperationStatus(zone, row.pending_gcp_operation_id);
        if (opStatus.status === 'DONE' && opStatus.error) {
          await this.db.query(
            `UPDATE projects SET status = 'error', status_message = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, opStatus.error]
          );
          await this.db.notify('project_state_changes', { projectId: row.id, status: 'error', error: opStatus.error });
        }
      }
    }
  }

  /**
   * Whole-UID Idle Reaper (C4 + M1) + 7-day FROZEN -> STOPPED auto-demotion (§10.2).
   */
  async runIdleReaper(): Promise<void> {
    // 1. Find idle RUNNING projects without an active operation lease (`busy_until`)
    const idleCandidates = await this.db.query(
      `SELECT p.id, p.state_version, p.compute_internal_ip, r.parsed_json AS template_json
       FROM projects p
       JOIN config_revisions r ON r.id = p.template_revision_id
       WHERE p.status = 'running'
         AND (p.busy_until IS NULL OR p.busy_until < NOW())
         AND p.last_activity_at < NOW() - make_interval(mins => p.idle_timeout_minutes)`
    );

    for (const proj of idleCandidates.rows) {
      // Poll bionic-daemon for whole-UID compute/agent/subagent/transfer activity before freezing!
      if (proj.compute_internal_ip) {
        try {
          const act = await this.callVmInternalApi(proj.id, proj.compute_internal_ip, 'GET', '/api/internal/activity');
          if (
            (act.activeAgentTurns || 0) > 0 ||
            (act.activeSubagents || 0) > 0 ||
            (act.activeComputeProcs || 0) > 0 ||
            (act.activeDataTransfers || 0) > 0
          ) {
            await this.db.query(`UPDATE projects SET last_activity_at = NOW() WHERE id = $1`, [proj.id]);
            continue;
          }
        } catch {
          // If VM is unreachable, allow spindown
        }
      }

      const tmpl = proj.template_json as ComputeTemplateConfig;
      const nextStatus = tmpl.compute.suspendSupported ? 'freezing' : 'stopping';
      const jobType = tmpl.compute.suspendSupported ? 'freeze_project' : 'stop_project';
      const nextVer = proj.state_version + 1;

      const updated = await this.db.withTransaction(async (client) => {
        const res = await client.query(
          `UPDATE projects
           SET status = $2, desired_state = $3, state_version = $4, transition_started_at = NOW(), updated_at = NOW()
           WHERE id = $1
             AND status = 'running'
             AND state_version = $5
             AND (busy_until IS NULL OR busy_until < NOW())
           RETURNING id`,
          [proj.id, nextStatus, tmpl.compute.suspendSupported ? 'frozen' : 'stopped', nextVer, proj.state_version]
        );
        if (res.rowCount === 0) return false;
        await client.query(
          `INSERT INTO jobs (id, queue, job_type, payload_json, idempotency_key)
           VALUES ($1, 'compute', $2, $3::jsonb, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            `job-idle-${proj.id.slice(-8)}-${nextVer}`,
            jobType,
            JSON.stringify({ projectId: proj.id, expectedStateVersion: nextVer }),
            `idle:${proj.id}:v${nextVer}`
          ]
        );
        return true;
      });
      if (updated) {
        await this.db.notify('project_state_changes', { projectId: proj.id, status: nextStatus });
      }
    }

    // 2. Auto-demote FROZEN > 7 days -> STOPPED atomically inside transaction (#26)
    const staleFrozen = await this.db.query(
      `SELECT id, state_version FROM projects
       WHERE status = 'frozen' AND frozen_at < NOW() - INTERVAL '7 days'`
    );
    for (const row of staleFrozen.rows) {
      const nextVer = row.state_version + 1;
      await this.db.withTransaction(async (client) => {
        const upd = await client.query(
          `UPDATE projects SET status = 'stopping', desired_state = 'stopped', state_version = $2, transition_started_at = NOW()
           WHERE id = $1 AND status = 'frozen' AND state_version = $3 RETURNING id`,
          [row.id, nextVer, row.state_version]
        );
        if (upd.rowCount === 0) return;
        await client.query(
          `INSERT INTO jobs (id, queue, job_type, payload_json, idempotency_key)
           VALUES ($1, 'compute', 'stop_project', $2::jsonb, $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            `job-demote-${row.id.slice(-8)}-${nextVer}`,
            JSON.stringify({ projectId: row.id, expectedStateVersion: nextVer }),
            `demote:${row.id}:v${nextVer}`
          ]
        );
      });
    }
  }

  /**
   * 15-minute-grace GCP Orphan Sweeper (H1): destroys managed VMs whose DB row is missing/deleted
   * and whose creationTimestamp is > 15 minutes old.
   */
  async sweepOrphanResources(): Promise<void> {
    const managed = await this.compute.listManagedInstances(this.cfg.gcpDefaultZone, this.cfg.hubId);
    const cutoffMs = Date.now() - 15 * 60_000;

    for (const inst of managed) {
      const createdMs = inst.creationTimestamp ? new Date(inst.creationTimestamp).getTime() : 0;
      if (createdMs > cutoffMs) continue; // Respect 15m boot grace window

      const prjId = inst.labels?.['bionic-project-id'];
      const runId = inst.labels?.['bionic-run-id'];
      if (prjId) {
        const dbRes = await this.db.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [prjId]);
        const st = dbRes.rows[0]?.status;
        if (!st || st === 'deleted') {
          await this.compute.deleteInstance(inst.zone, inst.instanceName, true, `pd-${prjId}`);
        }
      } else if (runId) {
        const dbRes = await this.db.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
        const st = dbRes.rows[0]?.status;
        if (!st || ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(st)) {
          await this.compute.deleteInstance(inst.zone, inst.instanceName, true, `pd-${runId}`);
        }
      }
    }
  }

  /**
   * Daily DB housekeeping + stale LLM spend reservation expiry (H4).
   */
  async runHousekeeping(): Promise<void> {
    await this.db.withTransaction(async (client) => {
      // Expire stale LLM spend reservations (>10 min old)
      const expired = await client.query<{ scope_key: string; utc_day: string; amount_usd: string }>(
        `DELETE FROM llm_spend_reservations WHERE expires_at < NOW() RETURNING scope_key, utc_day, amount_usd`
      );
      for (const row of expired.rows) {
        await client.query(
          `UPDATE daily_llm_spend SET reserved_usd = GREATEST(0, reserved_usd - $3) WHERE scope_key = $1 AND utc_day = $2`,
          [row.scope_key, row.utc_day, row.amount_usd]
        );
      }
      await client.query(`DELETE FROM editor_auth_codes WHERE expires_at < NOW() - INTERVAL '1 hour'`);
      await client.query(`DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL '7 days'`);
      await client.query(`DELETE FROM scoped_origin_sessions WHERE expires_at < NOW() - INTERVAL '7 days'`);
      await client.query(`DELETE FROM jobs WHERE status = 'completed' AND updated_at < NOW() - INTERVAL '14 days'`);
      await client.query(`DELETE FROM data_objects WHERE status = 'uploading' AND created_at < NOW() - INTERVAL '7 days'`);
    }, this.db.workerPool);
  }
}
