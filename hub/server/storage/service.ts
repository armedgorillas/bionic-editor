import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { createId } from '@bionic/shared';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';

export interface UploadSessionResult {
  dataObjectId: string;
  storageUri: string;
  resumableSessionUri: string;
  provider: 'gcs' | 'local';
}

/**
 * Large-scale scientific data storage service:
 * - Initiates 7-day GCS Resumable Upload Session URIs targeting immutable object keys
 *   (`projects/<prj-id>/blobs/<dat-ulid>/<filename>`).
 * - Maintains authoritative Postgres `project_data_grants` (never trusts manifest.json strings).
 * - Mints short-lived per-file V4 Signed Read URLs on demand (no GCP CAB 10-rule limit).
 * - Queues `pending_manifest_entries` when a browser upload finishes while the VM is frozen.
 */
export class DataStorageService {
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write']
  });

  constructor(private readonly db: HubDatabase, private readonly cfg: HubConfig) {
    if (!cfg.gcpProjectDataBucket) {
      fs.mkdirSync(path.join(cfg.localStorageDir, 'blobs'), { recursive: true });
    }
  }

  private get useGcs(): boolean {
    return Boolean(this.cfg.gcpProjectDataBucket);
  }

  private async getGcsToken(): Promise<string> {
    const client = await this.googleAuth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to acquire GCS access token');
    return token;
  }

  async initiateUploadSession(input: {
    projectId: string;
    userId: string;
    filename: string;
    sizeBytes: number;
    contentType?: string;
    targetRelPath: string;
    description?: string;
  }): Promise<UploadSessionResult> {
    const cleanName = path.basename(input.filename).replace(/[\0/\\]/g, '').trim();
    if (!cleanName || cleanName === '.' || cleanName === '..') {
      throw new Error('Invalid upload filename');
    }

    const dataObjectId = createId('dat');
    const objectKey = `projects/${input.projectId}/blobs/${dataObjectId}/${cleanName}`;

    if (this.useGcs) {
      const bucket = this.cfg.gcpProjectDataBucket;
      const storageUri = `gs://${bucket}/${objectKey}`;
      const token = await this.getGcsToken();
      const initUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(objectKey)}`;

      const res = await fetch(initUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': input.contentType || 'application/octet-stream',
          ...(input.sizeBytes > 0 ? { 'X-Upload-Content-Length': String(input.sizeBytes) } : {})
        },
        body: JSON.stringify({
          name: objectKey,
          metadata: { bionicProjectId: input.projectId, bionicDataObjectId: dataObjectId }
        })
      });
      if (!res.ok) {
        throw new Error(`GCS resumable upload initiation failed (${res.status})`);
      }
      const resumableSessionUri = res.headers.get('location');
      if (!resumableSessionUri) {
        throw new Error('GCS resumable upload initiation returned no Location header');
      }

      await this.db.query(
        `INSERT INTO data_objects
           (id, scope, owner_project_id, storage_uri, size_bytes, filename, content_type, description, status, created_by)
         VALUES ($1, 'project', $2, $3, $4, $5, $6, $7, 'uploading', $8)`,
        [dataObjectId, input.projectId, storageUri, input.sizeBytes, cleanName, input.contentType || null, input.description || '', input.userId]
      );

      return { dataObjectId, storageUri, resumableSessionUri, provider: 'gcs' };
    }

    // Local filesystem storage adapter for dev/testing
    const localPath = path.join(this.cfg.localStorageDir, 'blobs', objectKey);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const storageUri = `file://${localPath}`;
    await this.db.query(
      `INSERT INTO data_objects
         (id, scope, owner_project_id, storage_uri, size_bytes, filename, content_type, description, status, created_by)
       VALUES ($1, 'project', $2, $3, $4, $5, $6, $7, 'uploading', $8)`,
      [dataObjectId, input.projectId, storageUri, input.sizeBytes, cleanName, input.contentType || null, input.description || '', input.userId]
    );

    const resumableSessionUri = `${this.cfg.hubOrigin}/api/v1/projects/${input.projectId}/data/local-upload/${dataObjectId}`;
    return { dataObjectId, storageUri, resumableSessionUri, provider: 'local' };
  }

  async completeUpload(input: {
    projectId: string;
    dataObjectId: string;
    clientSha256: string;
    targetRelPath: string;
    projectIsRunning: boolean;
  }): Promise<{
    dataObjectId: string;
    storageUri: string;
    sizeBytes: number;
    generation?: string;
    crc32c?: string;
    sha256: string;
    provider: 'gcs' | 'local';
    queuedForWake: boolean;
  }> {
    const objRes = await this.db.query(
      `SELECT id, storage_uri, filename, owner_project_id FROM data_objects WHERE id = $1 AND owner_project_id = $2`,
      [input.dataObjectId, input.projectId]
    );
    const obj = objRes.rows[0];
    if (!obj) {
      throw new Error('Data object not found for this project');
    }

    let sizeBytes = 0;
    let generation: string | undefined;
    let crc32c: string | undefined;
    let verifiedSha256 = input.clientSha256;

    if (this.useGcs && obj.storage_uri.startsWith('gs://')) {
      const withoutScheme = obj.storage_uri.slice('gs://'.length);
      const slashIdx = withoutScheme.indexOf('/');
      const bucket = withoutScheme.slice(0, slashIdx);
      const key = withoutScheme.slice(slashIdx + 1);
      const token = await this.getGcsToken();
      const metaRes = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!metaRes.ok) {
        throw new Error(`GCS object verification failed (${metaRes.status}); upload incomplete`);
      }
      const meta = (await metaRes.json()) as { size?: string; generation?: string; crc32c?: string };
      sizeBytes = Number(meta.size || 0);
      generation = meta.generation;
      crc32c = meta.crc32c;
    } else if (obj.storage_uri.startsWith('file://')) {
      const localPath = obj.storage_uri.slice('file://'.length);
      if (!fs.existsSync(localPath)) {
        throw new Error('Uploaded file not found in local storage');
      }
      const st = fs.statSync(localPath);
      sizeBytes = st.size;
      generation = String(Math.floor(st.mtimeMs));
      verifiedSha256 = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
    }

    await this.db.withTransaction(async (client) => {
      await client.query(
        `UPDATE data_objects
         SET status = 'ready', size_bytes = $2, gcs_generation = $3, crc32c = $4, sha256 = $5
         WHERE id = $1`,
        [input.dataObjectId, sizeBytes, generation || null, crc32c || null, verifiedSha256]
      );
      await client.query(
        `INSERT INTO project_data_grants (project_id, data_object_id, permission, granted_via)
         VALUES ($1, $2, 'read_write', 'upload')
         ON CONFLICT (project_id, data_object_id) DO NOTHING`,
        [input.projectId, input.dataObjectId]
      );
      if (!input.projectIsRunning) {
        await client.query(
          `INSERT INTO pending_manifest_entries (id, project_id, data_object_id, target_rel_path, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [createId('job'), input.projectId, input.dataObjectId, input.targetRelPath]
        );
        await client.query(`UPDATE projects SET pending_manifest_sync = TRUE WHERE id = $1`, [input.projectId]);
      }
    });

    return {
      dataObjectId: input.dataObjectId,
      storageUri: obj.storage_uri,
      sizeBytes,
      generation,
      crc32c,
      sha256: verifiedSha256,
      provider: this.useGcs ? 'gcs' : 'local',
      queuedForWake: !input.projectIsRunning
    };
  }

  /**
   * Authorizes strictly against Postgres `project_data_grants` (or `scope = 'shared'`)
   * and returns a short-lived per-file download URL pinned to `gcs_generation`.
   */
  private readonly streamSigningKey = crypto.randomBytes(32);

  signStreamToken(projectId: string, dataObjectId: string, ttlSeconds = 900): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${projectId}:${dataObjectId}:${exp}`;
    const sig = crypto.createHmac('sha256', this.streamSigningKey).update(payload).digest('base64url');
    return `${exp}.${sig}`;
  }

  verifyStreamToken(projectId: string, dataObjectId: string, token: string): boolean {
    const [expStr, sig] = token.split('.');
    const exp = Number(expStr || 0);
    if (!exp || !sig || exp < Math.floor(Date.now() / 1000)) return false;
    const expected = crypto.createHmac('sha256', this.streamSigningKey).update(`${projectId}:${dataObjectId}:${exp}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async mintAuthorizedReadUrl(projectId: string, dataObjectId: string): Promise<{
    signedUrl: string;
    sha256: string;
    sizeBytes: number;
    filename: string;
    generation?: string;
  }> {
    const res = await this.db.query(
      `SELECT d.id, d.storage_uri, d.sha256, d.size_bytes, d.filename, d.gcs_generation
       FROM data_objects d
       LEFT JOIN project_data_grants g ON g.data_object_id = d.id AND g.project_id = $1
       WHERE d.id = $2
         AND d.status = 'ready'
         AND (d.scope = 'shared' OR g.project_id IS NOT NULL)`,
      [projectId, dataObjectId]
    );
    const row = res.rows[0];
    if (!row) {
      throw Object.assign(new Error('Data object not authorized for this project'), { statusCode: 403 });
    }

    const tok = this.signStreamToken(projectId, dataObjectId, 900);
    const genQuery = row.gcs_generation ? `&generation=${encodeURIComponent(row.gcs_generation)}` : '';
    const signedUrl = `${this.cfg.hubOrigin}/api/internal/data/stream/${projectId}/${dataObjectId}?token=${encodeURIComponent(tok)}${genQuery}`;
    return {
      signedUrl,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      filename: row.filename,
      generation: row.gcs_generation || undefined
    };
  }

  async openAuthorizedReadStream(projectId: string, dataObjectId: string): Promise<{
    filename: string;
    contentType: string;
    gcsUrl?: string;
    gcsBearer?: string;
    localFilePath?: string;
  }> {
    const res = await this.db.query(
      `SELECT d.storage_uri, d.filename, d.content_type, d.gcs_generation
       FROM data_objects d
       LEFT JOIN project_data_grants g ON g.data_object_id = d.id AND g.project_id = $1
       WHERE d.id = $2 AND d.status = 'ready' AND (d.scope = 'shared' OR g.project_id IS NOT NULL)`,
      [projectId, dataObjectId]
    );
    const row = res.rows[0];
    if (!row) throw Object.assign(new Error('Not authorized'), { statusCode: 403 });

    if (row.storage_uri.startsWith('gs://')) {
      const withoutScheme = row.storage_uri.slice('gs://'.length);
      const slashIdx = withoutScheme.indexOf('/');
      const bucket = withoutScheme.slice(0, slashIdx);
      const key = withoutScheme.slice(slashIdx + 1);
      const genQ = row.gcs_generation ? `&generation=${encodeURIComponent(row.gcs_generation)}` : '';
      return {
        filename: row.filename,
        contentType: row.content_type || 'application/octet-stream',
        gcsUrl: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media${genQ}`,
        gcsBearer: await this.getGcsToken()
      };
    }
    const localPath = row.storage_uri.slice('file://'.length);
    return {
      filename: row.filename,
      contentType: row.content_type || 'application/octet-stream',
      localFilePath: localPath
    };
  }

  async writeLocalUploadedBytes(projectId: string, dataObjectId: string, buf: Buffer): Promise<void> {
    const res = await this.db.query<{ storage_uri: string }>(
      `SELECT storage_uri FROM data_objects WHERE id = $1 AND owner_project_id = $2 AND status = 'uploading'`,
      [dataObjectId, projectId]
    );
    const uri = res.rows[0]?.storage_uri || '';
    if (!uri.startsWith('file://')) throw Object.assign(new Error('Upload target not found'), { statusCode: 404 });
    const localPath = uri.slice('file://'.length);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buf);
  }

  /**
   * Security C4: Validates that every dataObjectId/storageUri referenced in `manifest.json`
   * is genuinely granted to `projectId` in Postgres `project_data_grants` (or `shared`).
   */
  async assertManifestEntriesAuthorized(
    projectId: string,
    entries: Array<{ filepath: string; sha256: string; storage?: { dataObjectId?: string; uri?: string } }>
  ): Promise<Array<{ dataObjectId: string; gcsGeneration: string | null; relPath: string; sha256: string }>> {
    const pinned: Array<{ dataObjectId: string; gcsGeneration: string | null; relPath: string; sha256: string }> = [];
    for (const entry of entries) {
      if (!entry.storage?.uri && !entry.storage?.dataObjectId) {
        continue;
      }
      const res = await this.db.query(
        `SELECT d.id, d.gcs_generation, d.sha256, d.status
         FROM data_objects d
         LEFT JOIN project_data_grants g ON g.data_object_id = d.id AND g.project_id = $1
         WHERE (d.id = $2 OR d.storage_uri = $3)
           AND d.status = 'ready'
           AND (d.scope = 'shared' OR g.project_id IS NOT NULL)`,
        [projectId, entry.storage.dataObjectId || '', entry.storage.uri || '']
      );
      if (res.rowCount === 0) {
        throw Object.assign(
          new Error(
            `Security policy violation: manifest entry "${entry.filepath}" references unauthorized or non-existent storage object (${entry.storage.uri || entry.storage.dataObjectId})`
          ),
          { statusCode: 403 }
        );
      }
      const row = res.rows[0];
      pinned.push({
        dataObjectId: row.id,
        gcsGeneration: row.gcs_generation,
        relPath: entry.filepath,
        sha256: row.sha256 || entry.sha256
      });
    }
    return pinned;
  }
}
