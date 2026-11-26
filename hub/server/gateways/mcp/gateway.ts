import type { FastifyRequest, FastifyReply } from 'fastify';
import type { McpServerConfig } from '@bionic/shared';
import type { HubDatabase } from '../../db/pool.js';
import type { HubConfig } from '../../config.js';
import type { SecretResolver } from '../../secrets/resolver.js';
import type { SessionService } from '../../auth/sessions.js';
import type { WorkloadJwtClaims } from '../../auth/ca.js';
import { assertSafeOutboundUrl } from '../ssrf.js';

/**
 * SSRF-hardened Remote MCP Gateway (`streamable_http` / `sse` only).
 * Injects admin-managed MCP secrets from Secret Manager so MCP secrets never touch Editor VMs,
 * enforces group RBAC, preserves `Mcp-Session-Id`, and logs audit events.
 */
export class McpGatewayService {
  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly secrets: SecretResolver,
    private readonly sessions: SessionService
  ) {}

  async proxyMcpRequest(
    slug: string,
    workload: WorkloadJwtClaims,
    claimedUserId: string | undefined,
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const srvRes = await this.db.query(
      `SELECT m.slug, m.transport, m.routing, m.allowed_group_ids, m.enabled, r.parsed_json
       FROM mcp_servers m
       JOIN config_revisions r ON r.id = m.active_revision_id
       WHERE m.slug = $1`,
      [slug]
    );
    const row = srvRes.rows[0];
    if (!row || !row.enabled) {
      reply.code(404).send({ error: `MCP server "${slug}" not found or disabled` });
      return;
    }
    if (row.routing !== 'hub_gateway' || row.transport === 'stdio') {
      reply.code(403).send({ error: `MCP server "${slug}" cannot be routed through hub_gateway` });
      return;
    }

    // Verify user belongs to project & allowed groups
    const projRes = await this.db.query(
      `SELECT p.owner_id, pm.role AS member_role
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       WHERE p.id = $1 AND p.status <> 'deleted'`,
      [workload.projectId, claimedUserId || '']
    );
    const proj = projRes.rows[0];
    if (!proj) {
      reply.code(403).send({ error: 'Project not authorized' });
      return;
    }
    const userId =
      claimedUserId && (proj.member_role === 'owner' || proj.member_role === 'editor' || proj.owner_id === claimedUserId)
        ? claimedUserId
        : proj.owner_id;

    const grpRes = await this.db.query<{ slug: string }>(
      `SELECT g.slug FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1`,
      [userId]
    );
    const userGroups = new Set(grpRes.rows.map((r) => r.slug));
    const allowed: string[] = row.allowed_group_ids || [];
    if (!userGroups.has('admins') && !allowed.some((g) => userGroups.has(g))) {
      reply.code(403).send({ error: `Not authorized to access MCP server "${slug}"` });
      return;
    }

    const spec = (row.parsed_json as McpServerConfig).spec;
    if (!spec.url) {
      reply.code(500).send({ error: 'MCP server missing upstream URL' });
      return;
    }

    // Re-validate SSRF on every outbound request (prevents DNS rebinding)
    await assertSafeOutboundUrl(spec.url, {
      allowHttp: this.cfg.devMode,
      allowedPrivateCidrs: this.cfg.allowedPrivateCidrs,
      blockedCidrs: this.cfg.blockedCidrs
    });

    const headers: Record<string, string> = {
      Accept: String(req.headers.accept || 'application/json, text/event-stream')
    };
    if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type']);
    if (req.headers['mcp-session-id']) headers['Mcp-Session-Id'] = String(req.headers['mcp-session-id']);

    if (spec.auth.type === 'bearer_secret_ref' && spec.auth.secretRef) {
      headers.Authorization = `Bearer ${await this.secrets.resolve(spec.auth.secretRef)}`;
    } else if (spec.auth.type === 'header_secret_ref' && spec.auth.secretRef && spec.auth.headerName) {
      headers[spec.auth.headerName] = await this.secrets.resolve(spec.auth.secretRef);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 30_000);

    try {
      const upstream = await fetch(spec.url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
        redirect: 'manual',
        signal: controller.signal
      });

      const outHeaders: Record<string, string> = {
        'Content-Type': upstream.headers.get('content-type') || 'application/json'
      };
      const sessionHdr = upstream.headers.get('mcp-session-id');
      if (sessionHdr) outHeaders['Mcp-Session-Id'] = sessionHdr;

      reply.hijack();
      reply.raw.writeHead(upstream.status, outHeaders);
      if (upstream.body) {
        for await (const chunk of upstream.body as any) {
          reply.raw.write(chunk);
        }
      }
      reply.raw.end();

      await this.sessions.recordAudit({
        actorUserId: userId,
        action: 'mcp.proxy_call',
        resourceType: 'mcp_server',
        resourceId: slug,
        metadata: { projectId: workload.projectId, method: req.method, status: upstream.status }
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
