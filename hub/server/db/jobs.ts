import type pg from 'pg';
import { createId } from '@bionic/shared';
import type { HubDatabase } from './pool.js';

export interface QueuedJob<T = Record<string, any>> {
  id: string;
  queue: string;
  job_type: string;
  payload_json: T;
  status: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
}

export async function enqueueJob(
  dbOrClient: HubDatabase | pg.PoolClient,
  input: {
    queue: string;
    jobType: string;
    payload: Record<string, any>;
    idempotencyKey?: string;
    maxAttempts?: number;
    runAfterSec?: number;
  }
): Promise<string | null> {
  const id = createId('job');
  const sql = `
    INSERT INTO jobs (id, queue, job_type, payload_json, max_attempts, run_after, idempotency_key)
    VALUES ($1, $2, $3, $4::jsonb, $5, NOW() + make_interval(secs => $6), $7)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const params = [
    id,
    input.queue,
    input.jobType,
    JSON.stringify(input.payload),
    input.maxAttempts ?? 5,
    input.runAfterSec ?? 0,
    input.idempotencyKey ?? null
  ];
  const queryFn = (dbOrClient as { query: (s: string, p: any[]) => Promise<pg.QueryResult> }).query.bind(dbOrClient);
  const res = await queryFn(sql, params);
  return res?.rows[0]?.id ?? null;
}

/**
 * Claims the next eligible job from `queue` using PostgreSQL `FOR UPDATE SKIP LOCKED`.
 * Safe for concurrent multi-replica workers with zero Redis dependency.
 */
export async function claimNextJob(
  db: HubDatabase,
  queue: string,
  workerId: string,
  leaseSeconds = 120
): Promise<QueuedJob | null> {
  return db.withTransaction(async (client) => {
    const res = await client.query<QueuedJob>(
      `
      SELECT id, queue, job_type, payload_json, status, attempts, max_attempts, idempotency_key
      FROM jobs
      WHERE queue = $1
        AND (
          (status = 'pending' AND run_after <= NOW())
          OR (status = 'running' AND locked_until < NOW())
        )
      ORDER BY run_after ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [queue]
    );
    const job = res.rows[0];
    if (!job) return null;

    await client.query(
      `
      UPDATE jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_by = $2,
          locked_until = NOW() + make_interval(secs => $3),
          updated_at = NOW()
      WHERE id = $1
      `,
      [job.id, workerId, leaseSeconds]
    );

    return { ...job, attempts: job.attempts + 1 };
  }, db.workerPool);
}

export async function completeJob(db: HubDatabase, jobId: string): Promise<void> {
  await db.workerPool.query(
    `UPDATE jobs SET status = 'completed', locked_until = NULL, updated_at = NOW() WHERE id = $1`,
    [jobId]
  );
}

export async function failJob(db: HubDatabase, job: QueuedJob, errMsg: string): Promise<void> {
  const isDead = job.attempts >= job.max_attempts;
  const backoffSec = Math.min(300, Math.pow(2, job.attempts) * 5);
  await db.workerPool.query(
    `
    UPDATE jobs
    SET status = $2,
        last_error = $3,
        locked_until = NULL,
        run_after = NOW() + make_interval(secs => $4),
        updated_at = NOW()
    WHERE id = $1
    `,
    [job.id, isDead ? 'dead' : 'pending', errMsg.slice(0, 2000), backoffSec]
  );
}
