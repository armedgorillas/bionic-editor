import fs from 'fs';

export interface HubConfig {
  port: number;
  host: string;
  role: 'all' | 'api' | 'proxy' | 'worker';
  hubId: string;
  domain: string;
  hubOrigin: string;
  publicReportsOrigin: string;
  devMode: boolean;

  // PostgreSQL
  databaseUrl: string;
  dbSslMode: 'disable' | 'require';
  apiPoolMax: number;
  workerPoolMax: number;

  // Auth / OIDC & Demo Local Auth
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcClientSecretRef: string;
  bootstrapAdminEmail: string;
  bootstrapAdminPassword: string;
  localAuthEnabled: boolean;
  publicReportsRequireAuth: boolean;
  sessionTtlHours: number;

  // GCP & Compute
  computeProvider: 'gcp' | 'local';
  gcpProjectId: string;
  gcpDefaultZone: string;
  gcpEditorSubnet: string;
  gcpRunnerSubnet: string;
  gcpProjectDataBucket: string;
  gcpSharedDataBucket: string;
  gcpStaticPublicBucket: string;
  gcpStaticPrivateBucket: string;
  allowlistedTemplateSAs: Set<string>;
  runnerNoIamSaEmail: string;

  // Security & Egress
  allowedPrivateCidrs: string[];
  blockedCidrs: string[];
  internalCaPem?: string;
  internalCaKeyPem?: string;
  jwtPrivateKeyPem?: string;
  jwtPublicKeyPem?: string;

  // Git Upstream
  gitProvider: 'forgejo' | 'github' | 'local';
  gitUpstreamUrl: string;
  gitServiceToken: string;
  gitLocalReposDir: string;

  // Storage fallback for local dev/testing
  localStorageDir: string;
}

function readPemFromEnvOrFile(pem?: string, filePath?: string): string | undefined {
  if (pem) return pem;
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return undefined;
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  // Security #14: devMode ONLY enabled explicitly via HUB_DEV_MODE=true or NODE_ENV=test
  const devMode = env.HUB_DEV_MODE === 'true' || env.NODE_ENV === 'test';
  const domain = (env.HUB_DOMAIN || (devMode ? 'bionic.localhost' : '')).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!devMode && (!domain || domain.endsWith('.localhost'))) {
    throw new Error('HUB_DOMAIN must be set to a real domain in production (non-devMode)');
  }

  const scheme = devMode && !env.HUB_FORCE_HTTPS ? 'http' : 'https';
  const port = parseInt(env.HUB_PORT || '4000', 10);

  const allowlistedSAs = new Set(
    (env.HUB_ALLOWLISTED_SAS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const allowedPrivateCidrs = (env.HUB_ALLOWED_PRIVATE_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const blockedCidrs = (env.HUB_BLOCKED_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port,
    host: env.HUB_HOST || '127.0.0.1',
    role: (env.HUB_ROLE as HubConfig['role']) || 'all',
    hubId: env.HUB_ID || 'bionic-hub-dev',
    domain,
    hubOrigin: (env.HUB_ORIGIN || `${scheme}://hub.${domain}`).replace(/\/+$/, ''),
    publicReportsOrigin: (env.PUBLIC_REPORTS_ORIGIN || `${scheme}://public-reports.${domain}`).replace(/\/+$/, ''),
    devMode,

    databaseUrl: env.DATABASE_URL || 'postgres://bionic:bionic@127.0.0.1:5432/bionic_hub',
    dbSslMode: env.DB_SSL_MODE === 'require' || (env.DATABASE_URL || '').includes('sslmode=require') ? 'require' : 'disable',
    apiPoolMax: parseInt(env.DB_API_POOL_MAX || '8', 10),
    workerPoolMax: parseInt(env.DB_WORKER_POOL_MAX || '4', 10),

    oidcIssuer: env.OIDC_ISSUER || '',
    oidcClientId: env.OIDC_CLIENT_ID || '',
    oidcClientSecret: env.OIDC_CLIENT_SECRET || '',
    oidcClientSecretRef: env.OIDC_CLIENT_SECRET_REF || '',
    bootstrapAdminEmail: (env.BIONIC_BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim(),
    bootstrapAdminPassword: env.BIONIC_BOOTSTRAP_ADMIN_PASSWORD || '',
    localAuthEnabled: env.HUB_LOCAL_AUTH_ENABLED === 'true',
    publicReportsRequireAuth: env.HUB_PUBLIC_REPORTS_REQUIRE_AUTH === 'true',
    sessionTtlHours: parseInt(env.HUB_SESSION_TTL_HOURS || '24', 10),

    computeProvider: (env.HUB_COMPUTE_PROVIDER as 'gcp' | 'local') || 'local',
    gcpProjectId: env.GCP_PROJECT_ID || '',
    gcpDefaultZone: env.GCP_DEFAULT_ZONE || 'us-central1-a',
    gcpEditorSubnet: env.GCP_EDITOR_SUBNET || 'bionic-editors-subnet',
    gcpRunnerSubnet: env.GCP_RUNNER_SUBNET || 'bionic-runners-noegress-subnet',
    gcpProjectDataBucket: env.GCP_PROJECT_DATA_BUCKET || '',
    gcpSharedDataBucket: env.GCP_SHARED_DATA_BUCKET || '',
    gcpStaticPublicBucket: env.GCP_STATIC_PUBLIC_BUCKET || '',
    gcpStaticPrivateBucket: env.GCP_STATIC_PRIVATE_BUCKET || '',
    allowlistedTemplateSAs: allowlistedSAs,
    runnerNoIamSaEmail: env.GCP_RUNNER_NOIAM_SA || '',

    allowedPrivateCidrs,
    blockedCidrs,
    internalCaPem: readPemFromEnvOrFile(env.HUB_INTERNAL_CA_CERT_PEM, env.HUB_INTERNAL_CA_CERT_FILE),
    internalCaKeyPem: readPemFromEnvOrFile(env.HUB_INTERNAL_CA_KEY_PEM, env.HUB_INTERNAL_CA_KEY_FILE),
    jwtPrivateKeyPem: readPemFromEnvOrFile(env.HUB_JWT_PRIVATE_KEY_PEM, env.HUB_JWT_PRIVATE_KEY_FILE),
    jwtPublicKeyPem: readPemFromEnvOrFile(env.HUB_JWT_PUBLIC_KEY_PEM, env.HUB_JWT_PUBLIC_KEY_FILE),

    gitProvider: (env.HUB_GIT_PROVIDER as HubConfig['gitProvider']) || 'local',
    gitUpstreamUrl: (env.HUB_GIT_UPSTREAM_URL || '').replace(/\/+$/, ''),
    gitServiceToken: env.HUB_GIT_SERVICE_TOKEN || '',
    gitLocalReposDir: env.HUB_GIT_LOCAL_DIR || '/tmp/opencode/bionic-hub-git',

    localStorageDir: env.HUB_LOCAL_STORAGE_DIR || '/tmp/opencode/bionic-hub-storage'
  };
}
