import crypto from 'crypto';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand
} from '@aws-sdk/client-bedrock-runtime';
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import type { FastifyReply } from 'fastify';
import type { ModelConfig } from '@bionic/shared';
import type { HubDatabase } from '../../db/pool.js';
import type { HubConfig } from '../../config.js';
import type { SecretResolver } from '../../secrets/resolver.js';
import type { WorkloadJwtClaims } from '../../auth/ca.js';
import { assertSafeOutboundUrl } from '../ssrf.js';

export interface ResolvedModelRecord {
  slug: string;
  config: ModelConfig;
}

export class LlmGatewayService {
  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly secrets: SecretResolver
  ) {}

  async listModelsForUser(groupSlugs: string[]): Promise<Array<{
    slug: string;
    displayName: string;
    provider: string;
    protocol: 'anthropic' | 'openai' | 'google';
    modelId: string;
  }>> {
    const res = await this.db.query(
      `SELECT m.slug, m.display_name, m.provider_type, m.protocol, r.parsed_json
       FROM models m
       JOIN config_revisions r ON r.id = m.active_revision_id
       WHERE m.enabled = TRUE
         AND (m.allowed_group_ids && $1::text[] OR 'admins' = ANY($1::text[]))
       ORDER BY m.slug ASC`,
      [groupSlugs]
    );
    return res.rows.map((row) => ({
      slug: row.slug,
      displayName: row.display_name,
      provider: row.provider_type,
      protocol: row.protocol,
      modelId: row.parsed_json?.spec?.modelId || row.slug
    }));
  }

  /**
   * Security C5: Verifies `triggeringUserId` is an active owner/editor of the Workload JWT's
   * `projectId`, checks group RBAC for `modelSlug`, and atomically reserves daily spend.
   */
  async authorizeAndReserve(input: {
    workload: WorkloadJwtClaims;
    claimedUserId?: string;
    modelSlug: string;
    estimatedCostUsd?: number;
  }): Promise<{
    userId: string;
    model: ResolvedModelRecord;
    reservationId: string;
    userScopeKey: string;
    projectScopeKey: string;
    estimatedCostUsd: number;
  }> {
    // 1. Resolve verified triggering user (must be owner/editor of JWT's projectId)
    const projRes = await this.db.query(
      `SELECT p.owner_id, pm.role AS member_role
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       WHERE p.id = $1 AND p.status <> 'deleted'`,
      [input.workload.projectId, input.claimedUserId || '']
    );
    const proj = projRes.rows[0];
    if (!proj) {
      throw Object.assign(new Error('Project not found or deleted'), { statusCode: 403 });
    }
    const verifiedUserId =
      input.claimedUserId && (proj.member_role === 'owner' || proj.member_role === 'editor' || proj.owner_id === input.claimedUserId)
        ? input.claimedUserId
        : proj.owner_id;

    // 2. Load user's groups and requested model
    const [grpRes, modelRes] = await Promise.all([
      this.db.query<{ slug: string }>(
        `SELECT g.slug FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1`,
        [verifiedUserId]
      ),
      this.db.query(
        `SELECT m.slug, m.allowed_group_ids, m.enabled, r.parsed_json
         FROM models m
         JOIN config_revisions r ON r.id = m.active_revision_id
         WHERE m.slug = $1`,
        [input.modelSlug]
      )
    ]);
    const modelRow = modelRes.rows[0];
    if (!modelRow || !modelRow.enabled) {
      throw Object.assign(new Error(`Model "${input.modelSlug}" is not enabled`), { statusCode: 403 });
    }

    const userGroups = new Set(grpRes.rows.map((r) => r.slug));
    const allowed: string[] = modelRow.allowed_group_ids || [];
    const isPermitted = userGroups.has('admins') || allowed.some((g) => userGroups.has(g));
    if (!isPermitted) {
      throw Object.assign(new Error(`User is not authorized to use model "${input.modelSlug}"`), { statusCode: 403 });
    }

    const modelConfig = modelRow.parsed_json as ModelConfig;
    const estCost = input.estimatedCostUsd ?? 0.25;
    const userLimit = modelConfig.spec.limits?.dailyBudgetUsdPerUser ?? 25;
    const projLimit = modelConfig.spec.limits?.dailyBudgetUsdPerProject ?? 100;

    const userScopeKey = `user:${verifiedUserId}`;
    const projectScopeKey = `project:${input.workload.projectId}`;
    const reservationId = crypto.randomBytes(12).toString('hex');

    // 3. Atomic O(1) spend reservation (prevents parallel subagents bypassing daily budget)
    await this.db.withTransaction(async (client) => {
      for (const [scopeKey, limitUsd] of [
        [userScopeKey, userLimit],
        [projectScopeKey, projLimit]
      ] as const) {
        await client.query(
          `INSERT INTO daily_llm_spend (scope_key, utc_day, spent_usd, reserved_usd)
           VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 0, 0)
           ON CONFLICT (scope_key, utc_day) DO NOTHING`,
          [scopeKey]
        );
        const upd = await client.query(
          `UPDATE daily_llm_spend
           SET reserved_usd = reserved_usd + $2, updated_at = NOW()
           WHERE scope_key = $1
             AND utc_day = (NOW() AT TIME ZONE 'UTC')::date
             AND (spent_usd + reserved_usd + $2) <= $3
           RETURNING spent_usd, reserved_usd`,
          [scopeKey, estCost, limitUsd]
        );
        if (upd.rowCount === 0) {
          throw Object.assign(new Error(`Daily LLM budget exceeded for ${scopeKey} (limit $${limitUsd}/day)`), {
            statusCode: 429
          });
        }
        await client.query(
          `INSERT INTO llm_spend_reservations (id, scope_key, utc_day, amount_usd, expires_at)
           VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date, $3, NOW() + INTERVAL '10 minutes')`,
          [`${reservationId}:${scopeKey}`, scopeKey, estCost]
        );
      }
    });

    return {
      userId: verifiedUserId,
      model: { slug: modelRow.slug, config: modelConfig },
      reservationId,
      userScopeKey,
      projectScopeKey,
      estimatedCostUsd: estCost
    };
  }

  async settleUsage(input: {
    projectId: string;
    userId: string;
    model: ResolvedModelRecord;
    reservationId: string;
    userScopeKey: string;
    projectScopeKey: string;
    estimatedCostUsd: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    latencyMs: number;
    statusCode: number;
  }): Promise<void> {
    const pricing = input.model.config.spec.pricing;
    const actualCost =
      (input.promptTokens / 1_000_000) * (pricing?.inputPerMillionUsd ?? 0) +
      (input.completionTokens / 1_000_000) * (pricing?.outputPerMillionUsd ?? 0) +
      (input.cachedTokens / 1_000_000) * (pricing?.cachedInputPerMillionUsd ?? 0);

    await this.db.withTransaction(async (client) => {
      for (const scopeKey of [input.userScopeKey, input.projectScopeKey]) {
        const resId = `${input.reservationId}:${scopeKey}`;
        const del = await client.query(`DELETE FROM llm_spend_reservations WHERE id = $1 RETURNING amount_usd`, [resId]);
        const reserved = del.rows[0] ? Number(del.rows[0].amount_usd) : 0;
        await client.query(
          `UPDATE daily_llm_spend
           SET spent_usd = spent_usd + $2,
               reserved_usd = GREATEST(0, reserved_usd - $3),
               updated_at = NOW()
           WHERE scope_key = $1 AND utc_day = (NOW() AT TIME ZONE 'UTC')::date`,
          [scopeKey, actualCost, reserved]
        );
      }

      await client.query(
        `INSERT INTO llm_usage_events
           (project_id, user_id, model_slug, provider_type, prompt_tokens, completion_tokens, cached_tokens, cost_usd, latency_ms, status_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.projectId,
          input.userId,
          input.model.slug,
          input.model.config.spec.provider,
          input.promptTokens,
          input.completionTokens,
          input.cachedTokens,
          actualCost,
          input.latencyMs,
          input.statusCode
        ]
      );
    });
  }

  private async createBedrockClient(model: ModelConfig): Promise<BedrockRuntimeClient> {
    const region = model.spec.region || 'us-east-1';
    const auth = model.spec.auth;
    if (auth.type === 'aws_sts_web_identity') {
      const idToken = await this.secrets.fetchGcpOidcIdentityToken(auth.audience);
      const sts = new STSClient({ region });
      const assumed = await sts.send(
        new AssumeRoleWithWebIdentityCommand({
          RoleArn: auth.roleArn,
          RoleSessionName: `bionic-hub-${Date.now()}`,
          WebIdentityToken: idToken,
          DurationSeconds: 900
        })
      );
      if (!assumed.Credentials?.AccessKeyId || !assumed.Credentials.SecretAccessKey) {
        throw new Error('AWS STS AssumeRoleWithWebIdentity returned empty credentials');
      }
      return new BedrockRuntimeClient({
        region,
        credentials: {
          accessKeyId: assumed.Credentials.AccessKeyId,
          secretAccessKey: assumed.Credentials.SecretAccessKey,
          sessionToken: assumed.Credentials.SessionToken
        }
      });
    }

    if (auth.type === 'aws_secret_ref') {
      const [accessKeyId, secretAccessKey] = await Promise.all([
        this.secrets.resolve(auth.accessKeySecretRef),
        this.secrets.resolve(auth.secretKeySecretRef)
      ]);
      return new BedrockRuntimeClient({
        region,
        credentials: { accessKeyId, secretAccessKey }
      });
    }

    return new BedrockRuntimeClient({ region });
  }

  /**
   * Native Anthropic Messages endpoint (`/llm/anthropic/v1/messages`).
   * Routes both Direct Anthropic API and AWS Bedrock Claude (via InvokeModelWithResponseStream
   * preserving extended thinking blocks, signatures, and cache_control!).
   */
  async proxyAnthropicMessages(
    model: ResolvedModelRecord,
    body: Record<string, any>,
    reply: FastifyReply
  ): Promise<{ promptTokens: number; completionTokens: number; cachedTokens: number; statusCode: number }> {
    const spec = model.config.spec;
    if (spec.protocol !== 'anthropic') {
      throw Object.assign(new Error(`Model "${model.slug}" uses protocol "${spec.protocol}", not "anthropic"`), { statusCode: 400 });
    }
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    if (spec.provider === 'aws_bedrock') {
      const client = await this.createBedrockClient(model.config);
      const isStream = body.stream !== false;
      const bedrockPayload: Record<string, any> = { ...body, anthropic_version: 'bedrock-2023-05-31' };
      delete bedrockPayload.model;
      delete bedrockPayload.stream;

      if (!isStream) {
        const resp = await client.send(
          new InvokeModelCommand({
            modelId: spec.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: Buffer.from(JSON.stringify(bedrockPayload))
          })
        );
        const text = Buffer.from(resp.body).toString('utf-8');
        try {
          const parsed = JSON.parse(text);
          promptTokens = parsed?.usage?.input_tokens || 0;
          completionTokens = parsed?.usage?.output_tokens || 0;
          cachedTokens = parsed?.usage?.cache_read_input_tokens || 0;
        } catch {}
        reply.hijack();
        reply.raw.writeHead(200, { 'Content-Type': 'application/json' });
        reply.raw.end(text);
        return { promptTokens, completionTokens, cachedTokens, statusCode: 200 };
      }

      const cmd = new InvokeModelWithResponseStreamCommand({
        modelId: spec.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: Buffer.from(JSON.stringify(bedrockPayload))
      });
      const resp = await client.send(cmd);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      if (resp.body) {
        for await (const event of resp.body) {
          if (event.chunk?.bytes) {
            const chunkText = Buffer.from(event.chunk.bytes).toString('utf-8');
            try {
              const parsed = JSON.parse(chunkText);
              const eventType = parsed.type || 'message';
              if (parsed.message?.usage) {
                promptTokens += parsed.message.usage.input_tokens || 0;
                cachedTokens += parsed.message.usage.cache_read_input_tokens || 0;
              }
              if (parsed.usage) {
                completionTokens += parsed.usage.output_tokens || 0;
              }
              reply.raw.write(`event: ${eventType}\ndata: ${chunkText}\n\n`);
            } catch {
              reply.raw.write(`data: ${chunkText}\n\n`);
            }
          }
        }
      }
      reply.raw.end();
      return { promptTokens, completionTokens, cachedTokens, statusCode: 200 };
    }

    // Direct Anthropic API
    const apiKey = spec.auth.type === 'secret_ref' ? await this.secrets.resolve(spec.auth.apiKeySecretRef) : '';
    const upstreamUrl = (spec.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
    await assertSafeOutboundUrl(upstreamUrl, {
      allowHttp: this.cfg.devMode,
      allowedPrivateCidrs: this.cfg.allowedPrivateCidrs,
      blockedCidrs: this.cfg.blockedCidrs
    });

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ ...body, model: spec.modelId })
    });

    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    let textBuf = '';
    if (upstream.body) {
      for await (const chunk of upstream.body as any) {
        reply.raw.write(chunk);
        textBuf += Buffer.from(chunk).toString('utf-8');
        if (textBuf.length > 65536) textBuf = textBuf.slice(-32768);
      }
    }
    reply.raw.end();
    const inMatch = textBuf.match(/"input_tokens"\s*:\s*(\d+)/g);
    const outMatch = textBuf.match(/"output_tokens"\s*:\s*(\d+)/g);
    if (inMatch) promptTokens = Number(inMatch[inMatch.length - 1].replace(/\D/g, '')) || 0;
    if (outMatch) completionTokens = Number(outMatch[outMatch.length - 1].replace(/\D/g, '')) || 0;
    return { promptTokens, completionTokens, cachedTokens, statusCode: upstream.status };
  }

  /**
   * Native OpenAI-compatible endpoint (`/llm/openai/v1/chat/completions`).
   * Routes OpenAI, Ollama, and non-Claude AWS Bedrock models via Converse / ConverseStream.
   */
  async proxyOpenAiChat(
    model: ResolvedModelRecord,
    body: Record<string, any>,
    reply: FastifyReply
  ): Promise<{ promptTokens: number; completionTokens: number; cachedTokens: number; statusCode: number }> {
    const spec = model.config.spec;
    if (spec.protocol !== 'openai') {
      throw Object.assign(new Error(`Model "${model.slug}" uses protocol "${spec.protocol}", not "openai"`), { statusCode: 400 });
    }
    let promptTokens = 0;
    let completionTokens = 0;

    if (spec.provider === 'aws_bedrock') {
      const client = await this.createBedrockClient(model.config);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const systemBlocks = msgs
        .filter((m: any) => m.role === 'system')
        .map((m: any) => ({ text: String(m.content || '') }));
      const converseMsgs = msgs
        .filter((m: any) => m.role !== 'system')
        .map((m: any) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
        }));

      const completionId = `chatcmpl-bedrock-${Date.now()}`;
      if (body.stream !== true) {
        const resp = await client.send(
          new ConverseCommand({
            modelId: spec.modelId,
            system: systemBlocks.length ? systemBlocks : undefined,
            messages: converseMsgs as any,
            inferenceConfig: {
              maxTokens: body.max_tokens || spec.limits.maxOutputTokens,
              temperature: body.temperature
            }
          })
        );
        promptTokens = resp.usage?.inputTokens || 0;
        completionTokens = resp.usage?.outputTokens || 0;
        const text = (resp.output?.message?.content || []).map((b: any) => b.text || '').join('');
        reply.hijack();
        reply.raw.writeHead(200, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            id: completionId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model.slug,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
          })
        );
        return { promptTokens, completionTokens, cachedTokens: 0, statusCode: 200 };
      }

      const resp = await client.send(
        new ConverseStreamCommand({
          modelId: spec.modelId,
          system: systemBlocks.length ? systemBlocks : undefined,
          messages: converseMsgs as any,
          inferenceConfig: {
            maxTokens: body.max_tokens || spec.limits.maxOutputTokens,
            temperature: body.temperature
          }
        })
      );

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      if (resp.stream) {
        for await (const ev of resp.stream) {
          if (ev.contentBlockDelta?.delta?.text) {
            const chunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model.slug,
              choices: [{ index: 0, delta: { content: ev.contentBlockDelta.delta.text }, finish_reason: null }]
            };
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          if (ev.metadata?.usage) {
            promptTokens += ev.metadata.usage.inputTokens || 0;
            completionTokens += ev.metadata.usage.outputTokens || 0;
          }
        }
      }
      reply.raw.write(`data: [DONE]\n\n`);
      reply.raw.end();
      return { promptTokens, completionTokens, cachedTokens: 0, statusCode: 200 };
    }

    const apiKey = spec.auth.type === 'secret_ref' ? await this.secrets.resolve(spec.auth.apiKeySecretRef) : 'ollama';
    const base = (spec.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const upstreamUrl = `${base}/chat/completions`;
    await assertSafeOutboundUrl(upstreamUrl, {
      allowHttp: this.cfg.devMode,
      allowedPrivateCidrs: this.cfg.allowedPrivateCidrs,
      blockedCidrs: this.cfg.blockedCidrs
    });

    const outBody: Record<string, any> = { ...body, model: spec.modelId };
    if (outBody.stream === true && !outBody.stream_options) {
      outBody.stream_options = { include_usage: true };
    }
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(outBody)
    });

    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    let textBuf = '';
    if (upstream.body) {
      for await (const chunk of upstream.body as any) {
        reply.raw.write(chunk);
        textBuf += Buffer.from(chunk).toString('utf-8');
        if (textBuf.length > 65536) textBuf = textBuf.slice(-32768);
      }
    }
    reply.raw.end();
    const pMatch = textBuf.match(/"prompt_tokens"\s*:\s*(\d+)/g);
    const cMatch = textBuf.match(/"completion_tokens"\s*:\s*(\d+)/g);
    if (pMatch) promptTokens = Number(pMatch[pMatch.length - 1].replace(/\D/g, '')) || 0;
    if (cMatch) completionTokens = Number(cMatch[cMatch.length - 1].replace(/\D/g, '')) || 0;
    return { promptTokens, completionTokens, cachedTokens: 0, statusCode: upstream.status };
  }

  /**
   * Native Google Gemini endpoint (`/llm/google/v1beta/models/:modelAction`).
   */
  async proxyGoogleGemini(
    model: ResolvedModelRecord,
    action: string,
    body: Record<string, any>,
    reply: FastifyReply
  ): Promise<{ promptTokens: number; completionTokens: number; cachedTokens: number; statusCode: number }> {
    const spec = model.config.spec;
    if (spec.protocol !== 'google') {
      throw Object.assign(new Error(`Model "${model.slug}" uses protocol "${spec.protocol}", not "google"`), { statusCode: 400 });
    }
    const apiKey = spec.auth.type === 'secret_ref' ? await this.secrets.resolve(spec.auth.apiKeySecretRef) : '';
    const base = (spec.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const safeAction = action.replace(/[^a-zA-Z0-9_:-]/g, '');
    const upstreamUrl = `${base}/models/${encodeURIComponent(spec.modelId)}:${safeAction}`;
    await assertSafeOutboundUrl(upstreamUrl, {
      allowHttp: this.cfg.devMode,
      allowedPrivateCidrs: this.cfg.allowedPrivateCidrs,
      blockedCidrs: this.cfg.blockedCidrs
    });

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body)
    });

    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    let textBuf = '';
    if (upstream.body) {
      for await (const chunk of upstream.body as any) {
        reply.raw.write(chunk);
        textBuf += Buffer.from(chunk).toString('utf-8');
        if (textBuf.length > 65536) textBuf = textBuf.slice(-32768);
      }
    }
    reply.raw.end();
    let promptTokens = 0;
    let completionTokens = 0;
    const pMatch = textBuf.match(/"promptTokenCount"\s*:\s*(\d+)/g);
    const cMatch = textBuf.match(/"candidatesTokenCount"\s*:\s*(\d+)/g);
    if (pMatch) promptTokens = Number(pMatch[pMatch.length - 1].replace(/\D/g, '')) || 0;
    if (cMatch) completionTokens = Number(cMatch[cMatch.length - 1].replace(/\D/g, '')) || 0;
    return { promptTokens, completionTokens, cachedTokens: 0, statusCode: upstream.status };
  }
}
