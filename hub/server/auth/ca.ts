import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type CryptoKey
} from 'jose';

const execFileAsync = promisify(execFile);

export interface IssuedCertificate {
  certPem: string;
  caCertPem: string;
  serialHex: string;
  expiresAt: Date;
}

export interface WorkloadJwtClaims {
  projectId: string;
  vmInstanceId: string;
  kind: 'editor' | 'runner';
  runId?: string;
}

export interface GceIdentityClaims {
  projectId: string;
  zone: string;
  instanceId: string;
  instanceName: string;
  sub: string;
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export class HubCertificateAuthority {
  private caCertPem: string;
  private caKeyPem: string;
  private hubClientCertPem: string;
  private hubClientKeyPem: string;
  private jwtPrivateKey!: CryptoKey;
  private jwtPublicKey!: CryptoKey;
  private readonly issuer: string;

  private constructor(
    issuer: string,
    caCertPem: string,
    caKeyPem: string,
    hubClientCertPem: string,
    hubClientKeyPem: string
  ) {
    this.issuer = issuer;
    this.caCertPem = caCertPem;
    this.caKeyPem = caKeyPem;
    this.hubClientCertPem = hubClientCertPem;
    this.hubClientKeyPem = hubClientKeyPem;
  }

  static async create(options: {
    issuer: string;
    caCertPem?: string;
    caKeyPem?: string;
    jwtPrivateKeyPem?: string;
    jwtPublicKeyPem?: string;
  }): Promise<HubCertificateAuthority> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-ca-'));
    try {
      fs.chmodSync(tmpDir, 0o700);
      let caCertPem = options.caCertPem;
      let caKeyPem = options.caKeyPem;

      if (!caCertPem || !caKeyPem) {
        const keyPath = path.join(tmpDir, 'ca.key');
        const certPath = path.join(tmpDir, 'ca.crt');
        await execFileAsync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
        await execFileAsync('openssl', [
          'req', '-x509', '-new', '-nodes',
          '-key', keyPath,
          '-sha256', '-days', '3650',
          '-subj', '/CN=Bionic Hub Internal CA/O=Bionic Hub',
          '-out', certPath
        ]);
        caKeyPem = fs.readFileSync(keyPath, 'utf-8');
        caCertPem = fs.readFileSync(certPath, 'utf-8');
      }

      const ca = new HubCertificateAuthority(options.issuer, caCertPem, caKeyPem, '', '');
      // Security #6: Load persistent Ed25519 JWT signing keys when configured (survives restarts & multi-replica!)
      if (options.jwtPrivateKeyPem && options.jwtPublicKeyPem) {
        ca.jwtPrivateKey = await importPKCS8(options.jwtPrivateKeyPem, 'EdDSA');
        ca.jwtPublicKey = await importSPKI(options.jwtPublicKeyPem, 'EdDSA');
      } else {
        const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
        ca.jwtPrivateKey = privateKey;
        ca.jwtPublicKey = publicKey;
      }

      // Issue Hub Client Cert (`SAN=URI:spiffe://bionic/hub`)
      const hubKeyPath = path.join(tmpDir, 'hub.key');
      const hubCsrPath = path.join(tmpDir, 'hub.csr');
      await execFileAsync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', hubKeyPath]);
      await execFileAsync('openssl', [
        'req', '-new', '-key', hubKeyPath, '-subj', '/CN=bionic-hub-proxy', '-out', hubCsrPath
      ]);
      const hubCsrPem = fs.readFileSync(hubCsrPath, 'utf-8');
      const hubCert = await ca.signCsr({
        csrPem: hubCsrPem,
        commonName: 'bionic-hub-proxy',
        sanUri: 'spiffe://bionic/hub',
        ttlHours: 24 * 365
      });
      ca.hubClientCertPem = hubCert.certPem;
      ca.hubClientKeyPem = fs.readFileSync(hubKeyPath, 'utf-8');

      return ca;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  getCaCertPem(): string {
    return this.caCertPem;
  }

  getHubClientCredentials(): { certPem: string; keyPem: string; caCertPem: string } {
    return {
      certPem: this.hubClientCertPem,
      keyPem: this.hubClientKeyPem,
      caCertPem: this.caCertPem
    };
  }

  /**
   * Signs a VM CSR with SAN=URI:spiffe://bionic/project/<prj-id> (default 72h TTL).
   */
  async signVmCsr(input: {
    csrPem: string;
    projectId: string;
    instanceId: string;
    ttlHours?: number;
  }): Promise<IssuedCertificate> {
    return this.signCsr({
      csrPem: input.csrPem,
      commonName: input.instanceId,
      sanUri: `spiffe://bionic/project/${input.projectId}`,
      ttlHours: input.ttlHours ?? 72
    });
  }

  private async signCsr(input: {
    csrPem: string;
    commonName: string;
    sanUri: string;
    ttlHours: number;
  }): Promise<IssuedCertificate> {
    if (!/^spiffe:\/\/bionic\/[a-z0-9/_-]+$/.test(input.sanUri)) {
      throw new Error(`Invalid SPIFFE SAN URI: ${input.sanUri}`);
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-sign-'));
    try {
      fs.chmodSync(tmpDir, 0o700);
      const caKeyPath = path.join(tmpDir, 'ca.key');
      const caCertPath = path.join(tmpDir, 'ca.crt');
      const csrPath = path.join(tmpDir, 'req.csr');
      const extPath = path.join(tmpDir, 'ext.cnf');
      const outCertPath = path.join(tmpDir, 'out.crt');

      fs.writeFileSync(caKeyPath, this.caKeyPem, { mode: 0o600 });
      fs.writeFileSync(caCertPath, this.caCertPem, { mode: 0o600 });
      fs.writeFileSync(csrPath, input.csrPem, { mode: 0o600 });

      const serialHex = crypto.randomBytes(16).toString('hex');
      const days = Math.max(1, Math.ceil(input.ttlHours / 24));
      const extContent = [
        'basicConstraints=CA:FALSE',
        'keyUsage=digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth,clientAuth',
        `subjectAltName=URI:${input.sanUri}`
      ].join('\n');
      fs.writeFileSync(extPath, extContent, { mode: 0o600 });

      await execFileAsync('openssl', [
        'x509', '-req',
        '-in', csrPath,
        '-CA', caCertPath,
        '-CAkey', caKeyPath,
        '-set_serial', `0x${serialHex}`,
        '-out', outCertPath,
        '-days', String(days),
        '-sha256',
        '-extfile', extPath
      ]);

      const certPem = fs.readFileSync(outCertPath, 'utf-8');
      const expiresAt = new Date(Date.now() + input.ttlHours * 3600 * 1000);
      return { certPem, caCertPem: this.caCertPem, serialHex, expiresAt };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async mintWorkloadJwt(claims: WorkloadJwtClaims, ttlSeconds = 900): Promise<string> {
    return new SignJWT({
      project_id: claims.projectId,
      vm_instance_id: claims.vmInstanceId,
      kind: claims.kind,
      ...(claims.runId ? { run_id: claims.runId } : {})
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setAudience('bionic-hub-gateway')
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.jwtPrivateKey);
  }

  async verifyWorkloadJwt(token: string): Promise<WorkloadJwtClaims> {
    const { payload } = await jwtVerify(token, this.jwtPublicKey, {
      issuer: this.issuer,
      audience: 'bionic-hub-gateway'
    });
    const projectId = String(payload.project_id || '');
    const vmInstanceId = String(payload.vm_instance_id || '');
    const kind = payload.kind === 'runner' ? 'runner' : 'editor';
    if (!projectId || !vmInstanceId) {
      throw new Error('Invalid workload JWT claims');
    }
    return {
      projectId,
      vmInstanceId,
      kind,
      runId: payload.run_id ? String(payload.run_id) : undefined
    };
  }

  /**
   * Verifies a Google GCE Instance Identity Token against Google's public JWKS.
   * Requires `format=full` so `google.compute_engine` claims are present.
   */
  async verifyGceIdentityJwt(identityJwt: string, expectedAudience: string): Promise<GceIdentityClaims> {
    const { payload } = await jwtVerify(identityJwt, GOOGLE_JWKS, {
      issuer: 'https://accounts.google.com',
      audience: expectedAudience
    });
    const gce = (payload as any)?.google?.compute_engine;
    if (!gce || !gce.instance_id || !gce.instance_name || !gce.project_id || !gce.zone) {
      throw new Error('GCE identity JWT missing google.compute_engine claims (ensure format=full)');
    }
    return {
      projectId: String(gce.project_id),
      zone: String(gce.zone),
      instanceId: String(gce.instance_id),
      instanceName: String(gce.instance_name),
      sub: String(payload.sub || '')
    };
  }
}

export function extractSpiffeSanFromPeerCert(peerCert: any): string | null {
  const san = String(peerCert?.subjectaltname || '');
  const match = san.match(/URI:(spiffe:\/\/[^\s,]+)/);
  return match ? match[1] : null;
}
