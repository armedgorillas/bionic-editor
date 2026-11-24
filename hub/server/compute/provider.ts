import { GoogleAuth } from 'google-auth-library';
import type { HubConfig } from '../config.js';

export interface CreateInstanceInput {
  instanceName: string;
  diskName: string;
  zone: string;
  imageSelfLink: string;
  machineType: string;
  bootDiskGb: number;
  workspaceDiskGb: number;
  workspaceDiskType: string;
  subnetName: string;
  serviceAccountEmail: string;
  labels: Record<string, string>;
  networkTags?: string[];
  maxRunDurationSec?: number;
  restoreSnapshotName?: string;
  hubOrigin: string;
  projectId: string;
  runId?: string;
}

export interface ComputeInstanceInfo {
  instanceName: string;
  instanceId: string;
  zone: string;
  status: 'PROVISIONING' | 'STAGING' | 'RUNNING' | 'SUSPENDING' | 'SUSPENDED' | 'STOPPING' | 'TERMINATED' | 'UNKNOWN';
  internalIp?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
}

export interface ComputeOperationResult {
  operationId: string;
  instanceId?: string;
  internalIp?: string;
}

export interface ComputeProvider {
  readonly kind: 'gcp' | 'local';
  createInstance(input: CreateInstanceInput): Promise<ComputeOperationResult>;
  suspendInstance(zone: string, instanceName: string): Promise<ComputeOperationResult>;
  resumeInstance(zone: string, instanceName: string): Promise<ComputeOperationResult>;
  stopInstance(zone: string, instanceName: string): Promise<ComputeOperationResult>;
  startInstance(zone: string, instanceName: string): Promise<ComputeOperationResult>;
  deleteInstance(zone: string, instanceName: string, deleteWorkspaceDisk: boolean, diskName?: string): Promise<ComputeOperationResult>;
  createDiskSnapshot(zone: string, diskName: string, snapshotName: string): Promise<ComputeOperationResult>;
  getInstance(zone: string, instanceName: string): Promise<ComputeInstanceInfo | null>;
  getOperationStatus(zone: string, operationId: string): Promise<{ status: 'PENDING' | 'RUNNING' | 'DONE'; error?: string }>;
  listManagedInstances(zone: string, hubId: string): Promise<ComputeInstanceInfo[]>;
}

/**
 * Direct GCP Compute Engine REST API driver (`direct_gce_api`).
 * Zero external CLI dependencies, zero per-project Terraform state bloat,
 * enforces zero public IPs (no accessConfigs) and strict resource labels.
 */
export class GcpComputeProvider implements ComputeProvider {
  readonly kind = 'gcp' as const;
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/compute']
  });

  constructor(private readonly cfg: HubConfig) {}

  private get project(): string {
    if (!this.cfg.gcpProjectId) throw new Error('GCP_PROJECT_ID is required for GcpComputeProvider');
    return this.cfg.gcpProjectId;
  }

  private async gceFetch(pathUrl: string, method = 'GET', body?: any): Promise<any> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to obtain GCP OAuth access token');

    const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${this.project}${pathUrl}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 404 && method === 'GET') return null;
    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const reason = parsed?.error?.errors?.[0]?.reason || parsed?.error?.message || `HTTP ${res.status}`;
      const err: any = new Error(`GCE API error (${res.status}): ${reason}`);
      err.code = reason;
      err.statusCode = res.status;
      throw err;
    }
    return parsed;
  }

  async createInstance(input: CreateInstanceInput): Promise<ComputeOperationResult> {
    const region = input.zone.slice(0, input.zone.lastIndexOf('-'));

    // 1. Ensure persistent workspace disk exists and WAIT for disk creation LRO before attaching (#26)
    const existingDisk = await this.gceFetch(`/zones/${input.zone}/disks/${input.diskName}`, 'GET');
    if (!existingDisk) {
      const diskOp = await this.gceFetch(`/zones/${input.zone}/disks`, 'POST', {
        name: input.diskName,
        sizeGb: String(input.workspaceDiskGb),
        type: `zones/${input.zone}/diskTypes/${input.workspaceDiskType}`,
        ...(input.restoreSnapshotName
          ? { sourceSnapshot: `global/snapshots/${input.restoreSnapshotName}` }
          : {}),
        labels: input.labels
      });
      if (diskOp?.name) {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const st = await this.getOperationStatus(input.zone, String(diskOp.name));
          if (st.status === 'DONE') {
            if (st.error) throw new Error(`Workspace disk creation failed: ${st.error}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    // 2. Provision GCE instance with ZERO external/public IP (accessConfigs intentionally omitted!)
    //    No secrets are ever placed in metadata.items — VM authenticates via GCE Instance Identity JWT.
    const instanceBody: Record<string, any> = {
      name: input.instanceName,
      machineType: `zones/${input.zone}/machineTypes/${input.machineType}`,
      labels: input.labels,
      tags: { items: input.networkTags || ['bionic-editor-vm'] },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: input.imageSelfLink,
            diskSizeGb: String(input.bootDiskGb),
            diskType: `zones/${input.zone}/diskTypes/pd-balanced`
          }
        },
        {
          boot: false,
          autoDelete: false,
          deviceName: 'bionic-workspace',
          source: `zones/${input.zone}/disks/${input.diskName}`
        }
      ],
      networkInterfaces: [
        {
          subnetwork: `regions/${region}/subnetworks/${input.subnetName}`
          // accessConfigs omitted => ZERO public IP!
        }
      ],
      serviceAccounts: [
        {
          email: input.serviceAccountEmail,
          scopes: ['https://www.googleapis.com/auth/cloud-platform']
        }
      ],
      metadata: {
        items: [
          { key: 'bionic-hub-origin', value: input.hubOrigin },
          { key: 'bionic-project-id', value: input.projectId },
          ...(this.cfg.gcpSharedDataBucket
            ? [{ key: 'bionic-shared-data-bucket', value: this.cfg.gcpSharedDataBucket }]
            : []),
          ...(input.runId ? [{ key: 'bionic-run-id', value: input.runId }] : []),
          { key: 'block-project-ssh-keys', value: 'true' }
        ]
      },
      shieldedInstanceConfig: {
        enableSecureBoot: true,
        enableVtpm: true,
        enableIntegrityMonitoring: true
      }
    };

    if (input.maxRunDurationSec) {
      instanceBody.scheduling = {
        maxRunDuration: { seconds: String(input.maxRunDurationSec) },
        instanceTerminationAction: 'DELETE'
      };
    }

    const op = await this.gceFetch(`/zones/${input.zone}/instances`, 'POST', instanceBody);
    return {
      operationId: String(op.name || ''),
      instanceId: op.targetId ? String(op.targetId) : undefined
    };
  }

  async suspendInstance(zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const op = await this.gceFetch(`/zones/${zone}/instances/${instanceName}/suspend`, 'POST');
    return { operationId: String(op.name || '') };
  }

  async resumeInstance(zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const op = await this.gceFetch(`/zones/${zone}/instances/${instanceName}/resume`, 'POST');
    return { operationId: String(op.name || '') };
  }

  async stopInstance(zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const op = await this.gceFetch(`/zones/${zone}/instances/${instanceName}/stop`, 'POST');
    return { operationId: String(op.name || '') };
  }

  async startInstance(zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const op = await this.gceFetch(`/zones/${zone}/instances/${instanceName}/start`, 'POST');
    return { operationId: String(op.name || '') };
  }

  async deleteInstance(
    zone: string,
    instanceName: string,
    deleteWorkspaceDisk: boolean,
    diskName?: string
  ): Promise<ComputeOperationResult> {
    let operationId = '';
    try {
      const op = await this.gceFetch(`/zones/${zone}/instances/${instanceName}`, 'DELETE');
      operationId = String(op?.name || '');
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
    if (deleteWorkspaceDisk && diskName) {
      try {
        await this.gceFetch(`/zones/${zone}/disks/${diskName}`, 'DELETE');
      } catch (err: any) {
        if (err.statusCode !== 404) throw err;
      }
    }
    return { operationId };
  }

  async createDiskSnapshot(zone: string, diskName: string, snapshotName: string): Promise<ComputeOperationResult> {
    const op = await this.gceFetch(`/zones/${zone}/disks/${diskName}/createSnapshot`, 'POST', {
      name: snapshotName
    });
    return { operationId: String(op.name || '') };
  }

  async getInstance(zone: string, instanceName: string): Promise<ComputeInstanceInfo | null> {
    const data = await this.gceFetch(`/zones/${zone}/instances/${instanceName}`, 'GET');
    if (!data) return null;
    return {
      instanceName: data.name,
      instanceId: String(data.id),
      zone,
      status: data.status || 'UNKNOWN',
      internalIp: data.networkInterfaces?.[0]?.networkIP,
      creationTimestamp: data.creationTimestamp,
      labels: data.labels || {}
    };
  }

  async getOperationStatus(zone: string, operationId: string): Promise<{ status: 'PENDING' | 'RUNNING' | 'DONE'; error?: string }> {
    const data = await this.gceFetch(`/zones/${zone}/operations/${operationId}`, 'GET');
    if (!data) return { status: 'DONE' };
    const errMsg = data.error?.errors?.map((e: any) => `${e.code}: ${e.message}`).join('; ');
    return { status: data.status || 'DONE', error: errMsg };
  }

  async listManagedInstances(zone: string, hubId: string): Promise<ComputeInstanceInfo[]> {
    const filter = encodeURIComponent(`labels.bionic-managed=true AND labels.bionic-hub-id=${hubId}`);
    const data = await this.gceFetch(`/zones/${zone}/instances?filter=${filter}`, 'GET');
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map((d: any) => ({
      instanceName: d.name,
      instanceId: String(d.id),
      zone,
      status: d.status || 'UNKNOWN',
      internalIp: d.networkInterfaces?.[0]?.networkIP,
      creationTimestamp: d.creationTimestamp,
      labels: d.labels || {}
    }));
  }
}

/**
 * Deterministic in-memory LocalComputeProvider for local development & automated tests.
 */
export class LocalComputeProvider implements ComputeProvider {
  readonly kind = 'local' as const;
  private readonly instances = new Map<string, ComputeInstanceInfo>();
  private opSeq = 1;

  async createInstance(input: CreateInstanceInput): Promise<ComputeOperationResult> {
    const instanceId = String(1000000 + this.opSeq++);
    this.instances.set(input.instanceName, {
      instanceName: input.instanceName,
      instanceId,
      zone: input.zone,
      status: 'RUNNING',
      internalIp: '127.0.0.1',
      creationTimestamp: new Date().toISOString(),
      labels: input.labels
    });
    return { operationId: `local-op-${this.opSeq}`, instanceId, internalIp: '127.0.0.1' };
  }

  async suspendInstance(_zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const inst = this.instances.get(instanceName);
    if (inst) inst.status = 'SUSPENDED';
    return { operationId: `local-op-${this.opSeq++}` };
  }

  async resumeInstance(_zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const inst = this.instances.get(instanceName);
    if (inst) inst.status = 'RUNNING';
    return { operationId: `local-op-${this.opSeq++}` };
  }

  async stopInstance(_zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const inst = this.instances.get(instanceName);
    if (inst) inst.status = 'TERMINATED';
    return { operationId: `local-op-${this.opSeq++}` };
  }

  async startInstance(_zone: string, instanceName: string): Promise<ComputeOperationResult> {
    const inst = this.instances.get(instanceName);
    if (inst) inst.status = 'RUNNING';
    return { operationId: `local-op-${this.opSeq++}` };
  }

  async deleteInstance(_zone: string, instanceName: string): Promise<ComputeOperationResult> {
    this.instances.delete(instanceName);
    return { operationId: `local-op-${this.opSeq++}` };
  }

  async createDiskSnapshot(): Promise<ComputeOperationResult> {
    return { operationId: `local-op-${this.opSeq++}` };
  }

  async getInstance(_zone: string, instanceName: string): Promise<ComputeInstanceInfo | null> {
    return this.instances.get(instanceName) ?? null;
  }

  async getOperationStatus(): Promise<{ status: 'DONE' }> {
    return { status: 'DONE' };
  }

  async listManagedInstances(_zone: string, hubId: string): Promise<ComputeInstanceInfo[]> {
    return Array.from(this.instances.values()).filter((i) => i.labels?.['bionic-hub-id'] === hubId);
  }
}
