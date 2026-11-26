import { EventEmitter } from 'events';
import pg from 'pg';
import type { HubConfig } from '../config.js';

const { Pool, Client } = pg;

export interface HubDatabase {
  apiPool: pg.Pool;
  workerPool: pg.Pool;
  events: EventEmitter;
  query: <T extends pg.QueryResultRow = any>(sql: string, params?: any[]) => Promise<pg.QueryResult<T>>;
  withTransaction: <T>(fn: (client: pg.PoolClient) => Promise<T>, pool?: pg.Pool) => Promise<T>;
  notify: (channel: 'project_state_changes' | 'session_revocations' | 'config_updated', payload: Record<string, any>) => Promise<void>;
  startListener: () => Promise<void>;
  close: () => Promise<void>;
}

export function createHubDatabase(cfg: HubConfig): HubDatabase {
  const ssl = cfg.dbSslMode === 'require' ? { rejectUnauthorized: false } : undefined;
  const apiPool = new Pool({
    connectionString: cfg.databaseUrl,
    ssl,
    max: cfg.apiPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  const workerPool = new Pool({
    connectionString: cfg.databaseUrl,
    ssl,
    max: cfg.workerPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  const events = new EventEmitter();
  events.setMaxListeners(500);

  let listenClient: pg.Client | null = null;
  let closed = false;

  async function startListener(): Promise<void> {
    if (closed || listenClient) return;
    const client = new Client({ connectionString: cfg.databaseUrl, ssl });
    listenClient = client;
    client.on('notification', (msg) => {
      if (!msg.channel || !msg.payload) return;
      try {
        events.emit(msg.channel, JSON.parse(msg.payload));
      } catch {
        events.emit(msg.channel, msg.payload);
      }
    });
    client.on('error', () => {
      listenClient = null;
      if (!closed) {
        setTimeout(() => {
          startListener().catch(() => {});
        }, 3000).unref();
      }
    });
    await client.connect();
    await client.query('LISTEN project_state_changes');
    await client.query('LISTEN session_revocations');
    await client.query('LISTEN config_updated');
  }

  async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, pool: pg.Pool = apiPool): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await fn(client);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function notify(
    channel: 'project_state_changes' | 'session_revocations' | 'config_updated',
    payload: Record<string, any>
  ): Promise<void> {
    const serialized = JSON.stringify(payload);
    await apiPool.query('SELECT pg_notify($1, $2)', [channel, serialized]);
    // Emit locally only when LISTEN client is not connected (prevents duplicate delivery!)
    if (!listenClient) {
      events.emit(channel, payload);
    }
  }

  return {
    apiPool,
    workerPool,
    events,
    query: (sql, params) => apiPool.query(sql, params),
    withTransaction,
    notify,
    startListener,
    close: async () => {
      closed = true;
      if (listenClient) {
        await listenClient.end().catch(() => {});
        listenClient = null;
      }
      await Promise.all([apiPool.end(), workerPool.end()]);
    }
  };
}
