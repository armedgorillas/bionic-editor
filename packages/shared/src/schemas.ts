import { z } from 'zod';
import yaml from 'js-yaml';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_REF_REGEX = /^(gcp-sm|aws-sm|env):\/\/.+$/;
const SAFE_ENV_NAME_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;

export const SlugSchema = z.string().regex(SLUG_REGEX, 'Must be a lowercase RFC 1123 slug (a-z, 0-9, hyphens)');

export const SecretBindingSchema = z.object({
  name: z.string().regex(SAFE_ENV_NAME_REGEX, 'Secret env name must be UPPER_SNAKE_CASE'),
  source: z.string().regex(SECRET_REF_REGEX, 'Secret source must be a secret manager URI (gcp-sm://, aws-sm://, env://)'),
  mount: z.enum(['env', 'file']).default('env'),
  filePath: z.string().min(1).optional()
}).refine((val) => val.mount !== 'file' || Boolean(val.filePath), {
  message: 'filePath is required when mount is "file"'
});

/**
 * Compute Template YAML (`templates/<slug>.yaml`)
 * Note: Raw root `startupScript` via HTTP API is intentionally disallowed (Security H2).
 * OS/packages are baked into Packer images; workspace customization uses non-root `workspaceInitHook`.
 */
export const ComputeTemplateSchema = z.object({
  apiVersion: z.literal('bionic.io/v1'),
  kind: z.literal('ComputeTemplate'),
  metadata: z.object({
    slug: SlugSchema,
    displayName: z.string().min(1).max(120),
    description: z.string().max(1000).default(''),
    allowedGroups: z.array(SlugSchema).min(1).default(['researchers', 'admins'])
  }),
  compute: z.object({
    provider: z.enum(['gcp', 'local']).default('gcp'),
    image: z.string().min(1),
    machineType: z.string().min(1).default('e2-standard-4'),
    zone: z.string().min(1).optional(),
    bootDiskGb: z.number().int().min(20).max(500).default(30),
    workspaceDiskGb: z.number().int().min(20).max(10000).default(100),
    workspaceDiskType: z.enum(['pd-standard', 'pd-balanced', 'pd-ssd']).default('pd-balanced'),
    suspendSupported: z.boolean().default(true),
    idleTimeoutDefaultMinutes: z.number().int().min(5).max(1440).default(20),
    idleTimeoutMaxMinutes: z.number().int().min(5).max(1440).default(180)
  }).refine((c) => c.idleTimeoutDefaultMinutes <= c.idleTimeoutMaxMinutes, {
    message: 'idleTimeoutDefaultMinutes cannot exceed idleTimeoutMaxMinutes'
  }),
  iam: z.object({
    serviceAccountEmail: z.string().email(),
    allowUserMetadataAdc: z.boolean().default(false)
  }),
  secrets: z.array(SecretBindingSchema).default([]),
  workspaceInitHook: z.object({
    enabled: z.boolean().default(false),
    script: z.string().max(32768).default('')
  }).optional()
}).strict();

export type ComputeTemplateConfig = z.infer<typeof ComputeTemplateSchema>;

/**
 * Model Registry YAML (`models/<slug>.yaml`)
 * Supports OpenAI, Anthropic, Gemini, Ollama, Vertex AI, and AWS Bedrock.
 */
export const ModelAuthSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('secret_ref'),
    apiKeySecretRef: z.string().regex(SECRET_REF_REGEX)
  }),
  z.object({
    type: z.literal('aws_sts_web_identity'),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/),
    audience: z.string().default('sts.amazonaws.com')
  }),
  z.object({
    type: z.literal('aws_secret_ref'),
    accessKeySecretRef: z.string().regex(SECRET_REF_REGEX),
    secretKeySecretRef: z.string().regex(SECRET_REF_REGEX)
  }),
  z.object({
    type: z.literal('none')
  })
]);

export const ModelConfigSchema = z.object({
  apiVersion: z.literal('bionic.io/v1'),
  kind: z.literal('ModelConfig'),
  metadata: z.object({
    slug: SlugSchema,
    displayName: z.string().min(1).max(120),
    description: z.string().max(1000).default(''),
    allowedGroups: z.array(SlugSchema).min(1).default(['researchers', 'admins']),
    enabled: z.boolean().default(true)
  }),
  spec: z.object({
    provider: z.enum(['openai', 'anthropic', 'gemini', 'ollama', 'aws_bedrock', 'vertex']),
    protocol: z.enum(['anthropic', 'openai', 'google']),
    modelId: z.string().min(1),
    region: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    auth: ModelAuthSchema,
    limits: z.object({
      maxContextTokens: z.number().int().positive().default(128000),
      maxOutputTokens: z.number().int().positive().default(8192),
      dailyBudgetUsdPerUser: z.number().positive().default(25),
      dailyBudgetUsdPerProject: z.number().positive().default(100)
    }).default({}),
    pricing: z.object({
      inputPerMillionUsd: z.number().nonnegative().default(0),
      outputPerMillionUsd: z.number().nonnegative().default(0),
      cachedInputPerMillionUsd: z.number().nonnegative().default(0)
    }).default({})
  }).refine((s) => s.provider !== 'aws_bedrock' || Boolean(s.region), {
    message: 'region is required for aws_bedrock models'
  })
}).strict();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Skill Registry YAML (`skills/<slug>/skill.yaml`)
 */
export const SkillConfigSchema = z.object({
  apiVersion: z.literal('bionic.io/v1'),
  kind: z.literal('SkillConfig'),
  metadata: z.object({
    slug: SlugSchema,
    displayName: z.string().min(1).max(120),
    description: z.string().max(1000).default(''),
    allowedGroups: z.array(SlugSchema).min(1).default(['researchers', 'admins']),
    enabled: z.boolean().default(true)
  }),
  spec: z.object({
    entryFile: z.string().default('SKILL.md'),
    files: z.record(z.string(), z.string()).default({})
  })
}).strict();

export type SkillConfig = z.infer<typeof SkillConfigSchema>;

/**
 * MCP Server Registry YAML (`mcp/<slug>.yaml`)
 * Security H2: Hard-rejects `transport: 'stdio'` when `routing: 'hub_gateway'`.
 */
export const McpServerConfigSchema = z.object({
  apiVersion: z.literal('bionic.io/v1'),
  kind: z.literal('McpServerConfig'),
  metadata: z.object({
    slug: SlugSchema,
    displayName: z.string().min(1).max(120),
    description: z.string().max(1000).default(''),
    allowedGroups: z.array(SlugSchema).min(1).default(['researchers', 'admins']),
    enabled: z.boolean().default(true)
  }),
  spec: z.object({
    transport: z.enum(['streamable_http', 'sse', 'stdio']),
    routing: z.enum(['hub_gateway', 'vm_local']).default('hub_gateway'),
    url: z.string().url().optional(),
    command: z.array(z.string().min(1)).optional(),
    auth: z.object({
      type: z.enum(['none', 'bearer_secret_ref', 'header_secret_ref']).default('none'),
      secretRef: z.string().regex(SECRET_REF_REGEX).optional(),
      headerName: z
        .string()
        .regex(/^[A-Za-z0-9-]+$/, 'headerName must contain only ASCII token characters (A-Z, 0-9, -)')
        .refine(
          (h) => !['host', 'content-length', 'transfer-encoding', 'connection', 'cookie'].includes(h.toLowerCase()),
          'Forbidden HTTP header name'
        )
        .optional()
    }).default({ type: 'none' }),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000)
  }).superRefine((spec, ctx) => {
    if (spec.transport === 'stdio' && spec.routing === 'hub_gateway') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Security policy violation: transport "stdio" is strictly forbidden on routing "hub_gateway"; use "vm_local" only.'
      });
    }
    if ((spec.transport === 'streamable_http' || spec.transport === 'sse') && !spec.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url is required for streamable_http and sse MCP servers'
      });
    }
    if (spec.transport === 'stdio' && (!spec.command || spec.command.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command array is required for stdio MCP servers'
      });
    }
    if (spec.routing === 'vm_local' && spec.auth.type !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hub-managed auth secrets cannot be attached to vm_local MCP servers'
      });
    }
  })
}).strict();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Analysis Module Manifest (`bionic.yaml`)
 * Simple, non-parameterized, self-contained reproducible module specification
 * delegating directly to portable bash scripts (`scripts/run.sh`).
 */
export const BionicModuleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: SlugSchema,
  description: z.string().max(1000).optional(),
  environment: z.object({
    pythonLockfile: z.string().min(1).default('requirements.txt'),
    rLockfile: z.string().min(1).optional()
  }).default({ pythonLockfile: 'requirements.txt' }),
  entrypoint: z.object({
    argv: z.array(z.string().min(1)).min(1).default(['bash', 'scripts/run.sh']),
    workdir: z.string().min(1).default('.')
  }).default({ argv: ['bash', 'scripts/run.sh'], workdir: '.' }),
  outputs: z.object({
    reportDir: z.string().min(1).default('web-report'),
    testResultsGlob: z.string().min(1).default('tests/scientific/*_results.json')
  }).default({ reportDir: 'web-report', testResultsGlob: 'tests/scientific/*_results.json' })
}).strict();

export type BionicModuleManifest = z.infer<typeof BionicModuleManifestSchema>;

/**
 * Data Manifest v2 Storage Extension (backwards-compatible with v1)
 */
export const DataStorageMetadataSchema = z.object({
  provider: z.enum(['gcs', 's3', 'local']),
  dataObjectId: z.string().min(1).optional(),
  uri: z.string().min(1),
  generation: z.string().optional(),
  crc32c: z.string().optional(),
  syncStatus: z.enum(['synced', 'pending', 'remote_only']).default('synced'),
  syncedAt: z.string().optional(),
  readOnly: z.boolean().default(false)
});

export type DataStorageMetadata = z.infer<typeof DataStorageMetadataSchema>;

export type ConfigKind = 'template' | 'model' | 'skill' | 'mcp';

export function parseConfigYaml(kind: ConfigKind, rawYaml: string): ComputeTemplateConfig | ModelConfig | SkillConfig | McpServerConfig {
  const doc = yaml.load(rawYaml, { schema: yaml.JSON_SCHEMA });
  switch (kind) {
    case 'template':
      return ComputeTemplateSchema.parse(doc);
    case 'model':
      return ModelConfigSchema.parse(doc);
    case 'skill':
      return SkillConfigSchema.parse(doc);
    case 'mcp':
      return McpServerConfigSchema.parse(doc);
  }
}

export function parseBionicModuleYaml(rawYaml: string): BionicModuleManifest {
  const doc = yaml.load(rawYaml, { schema: yaml.JSON_SCHEMA });
  return BionicModuleManifestSchema.parse(doc);
}
