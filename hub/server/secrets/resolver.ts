import { GoogleAuth } from 'google-auth-library';

interface CachedSecret {
  value: string;
  expiresAtMs: number;
}

/**
 * Resolves Secret Manager references (`gcp-sm://projects/.../secrets/.../versions/...`)
 * or dev environment references (`env://VAR_NAME`). Never logs secret values.
 */
export class SecretResolver {
  private readonly cache = new Map<string, CachedSecret>();
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });

  async resolve(secretRef: string): Promise<string> {
    const cached = this.cache.get(secretRef);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.value;
    }

    let value: string;
    if (secretRef.startsWith('env://')) {
      const varName = secretRef.slice('env://'.length).trim();
      const envVal = process.env[varName];
      if (!envVal) {
        throw new Error(`Secret env var not set: ${varName}`);
      }
      value = envVal;
    } else if (secretRef.startsWith('gcp-sm://')) {
      const resource = secretRef.slice('gcp-sm://'.length).replace(/^\/+/, '');
      if (!/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/.test(resource)) {
        throw new Error(`Invalid GCP Secret Manager reference format: ${secretRef}`);
      }
      const client = await this.googleAuth.getClient();
      const tokenRes = await client.getAccessToken();
      const accessToken = tokenRes.token;
      if (!accessToken) {
        throw new Error('Failed to obtain GCP access token for Secret Manager');
      }
      const res = await fetch(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) {
        throw new Error(`GCP Secret Manager access failed (${res.status}) for ${resource}`);
      }
      const body = (await res.json()) as { payload?: { data?: string } };
      if (!body.payload?.data) {
        throw new Error(`Empty secret payload for ${resource}`);
      }
      value = Buffer.from(body.payload.data, 'base64').toString('utf-8');
    } else {
      throw new Error(`Unsupported secret URI scheme: ${secretRef.split('://')[0]}`);
    }

    this.cache.set(secretRef, { value, expiresAtMs: Date.now() + 5 * 60 * 1000 });
    return value;
  }

  /**
   * Fetches a GCP Service Account OIDC ID token from GCE metadata server
   * for GCP-to-AWS STS AssumeRoleWithWebIdentity (zero static AWS keys!).
   */
  async fetchGcpOidcIdentityToken(audience: string): Promise<string> {
    if (process.env.HUB_MOCK_GCP_OIDC_TOKEN) {
      return process.env.HUB_MOCK_GCP_OIDC_TOKEN;
    }
    const url = `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) {
      throw new Error(`Failed to fetch GCP OIDC identity token (${res.status})`);
    }
    return res.text();
  }
}
