# Major improvements

## Original Requirements

This is a major renovation to this project. Right now this is just a text editor deployed on a machine. I need to turn this into an enterprise tool.

Create the Bionic Hub, which is a management layer for deploying Bionic Editor projects.

### User Experience

* Users should be able to create a new project or create one from a completed project
* They should be able to reopen and continue their projects
* They should be able to publish their projects (assume as static site has been set up, and the publish operation has the ability to push the web-report to it)
* There is some sort of data storate. The data files might get big so thing about this for a moment
* A finished project has both the published version and the git code, forming a reproducible, self-contained analysis module with data and code that can be fired up from the environment

### Admin experience

* The hub has auth obviously
* The hub then spins up a computer from a system of … docker images? Image templates? Image templates to start with for the class because it is easier to pass in the underlying role and docker is redundant anyway
* The admins manage the system templates, which are published via CI and added via an API. This is a YAML which is basically the terraform + the startup script + the system role + the system secrets
* The hub also has available models configurable by an admin
* Manage skills, MCP connections
* Again, via text files in an API, which can be kept under version control and updated via API

### System requirements

* The bionic hub will be hosted on a server and not just be a JS app
* Postgres database for configuration
* Security is a MUST
* Each instance of the editor is a "project" with a unique ID
* Editor machines should be frozen and spun down after 20 (but configurable) minutes of inactivity

### Advanced features

* Admins can point to basic model providers or models hosted on bedrock via their configuration

### Approach

I will test this out on my own GCP project using terraform.

But I also need an example project that I can host on my website and users can play around with.

---

# Bionic Hub — Enterprise Architecture & Implementation Plan (v3 — Implementation-Ready)

## 1. Executive Summary & Architectural Principles

**Bionic Hub** transforms Bionic Editor from a single-machine scientific IDE into an enterprise multi-tenant platform. Each analytical project receives a globally unique, RFC 1123 DNS-safe identifier (**`prj-<lowercase-ulid>`**, e.g. `prj-01jdx9k3m4...`; publications use `pub-<ulid>`, reproduction runs use `run-<ulid>`, data objects use `dat-<ulid>`) backed by:

1. **Isolated Compute**: A dedicated VM provisioned from an admin-curated **VM Image Template** (immutable Packer-built GCE Machine Image + pre-provisioned least-privilege Cloud IAM Service Account + persistent workspace disk),
2. **Versioned Code, Plans & Portable Scripts**: A per-project Git repository storing `SPEC.md`, `plans/`, `code/`, `scripts/` (`run.sh`, `publish.sh`, `data-pull.sh`, `data-push.sh`, `verify-data.sh`), `requirements.txt` / `uv.lock`, `data/manifest.json`, `tests/scientific/`, and `bionic.yaml`,
3. **Large-Scale Object Storage**: GCS (pluggable to S3) for GB–TB raw datasets referenced by immutable object generation + SHA-256 fingerprints, never committed to Git or leaked into reports, and
4. **Immutable Publications & Self-Contained Reproducible Analysis Modules**: Atomic static-site publishing of `web-report/` paired with exact Git commits, pinned immutable data references, locked environments (`uv.lock`/`requirements.txt`), and one-click headless reproduction or interactive forking (`bionic.yaml`).

### Non-Negotiable Architectural Principles
1. **Zero-Trust Untrusted Compute + Tiny VM TCB**: Editor VMs execute arbitrary AI-generated Python/R/bash code and render agent-generated HTML/JS. Editor VMs have **zero public IPs, zero Postgres access, zero master LLM API keys, zero admin MCP secrets, zero Git tokens, zero east-west VM networking, and a strict two-unit OS privilege split** (`bionic-daemon.service` as `bionic-daemon` vs `bioniceditor.service` as `bionic-user`—requiring zero `root` / zero `CAP_SETUID` / zero `chown`).
2. **VM Image Templates as the Primary Isolation Boundary**: Hardware-virtualized VMs provide kernel-level multi-tenant isolation, native Cloud IAM role attachment, GPU/high-RAM sizing, and native suspend/stop lifecycles without container-escape or Docker-in-Docker complexity.
3. **Strict Origin Isolation**: Hub Control Plane (`hub.<domain>`), interactive Editors (`<prj-id>.editors.<domain>`), live/private report previews (`<prj-id>.reports.<domain>` / `<pub-id>.reports.<domain>`), and public static publications (`public-reports.<domain>`) run on **distinct origins** with host-only cookies so untrusted report JS can never hijack Hub or Editor sessions.
4. **GitOps Control Plane with Defense-in-Depth**: Templates, models, skills, and MCP servers are authored as version-controlled YAML/Markdown files, validated in CI, and applied via an authenticated declarative Admin API—stored as immutable revisions in PostgreSQL with dry-run diffs, audit logs, and instant rollback.
5. **No Hidden Magic — Portable Bash Scripts Under the Hood**: Every project workflow (running the analysis, pulling/pushing raw data, verifying provenance/leaks, and publishing `web-report/`) is implemented as simple, inspectable bash scripts inside the project's own `scripts/` folder (`scripts/run.sh`, `scripts/publish.sh`, `scripts/data-pull.sh`, `scripts/data-push.sh`, `scripts/verify-data.sh`). `scripts/` stays hidden in Scientist View and is revealed in Coding Mode. A coder can `git clone` or export any project to a laptop, HPC cluster, or CI runner and run every workflow with standard POSIX tools (`bash`, `curl`, `python3`, `git`, `sha256sum`, `gcloud`/`aws`/`rsync`) without losing a single capability—zero vendor lock-in. Inside Bionic Hub, the UI buttons invoke these exact scripts while Hub's server-side intake endpoints independently enforce all zero-trust security gates.
6. **Backwards-Compatible Bionic Editor**: Standalone `bioniceditor` (CLI/systemd/local dev) remains 100% functional. Enterprise capabilities activate via `BIONIC_HUB_MODE=true` and public website demo lockdown via `BIONIC_SANDBOX_MODE=true`.
7. **Single-Database Simplicity**: PostgreSQL 16 holds all control-plane state, sessions, config revisions, data grants, atomic LLM spend reservations, audit logs, and background job queues (`SELECT ... FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`) with zero Redis/Kafka requirement.

---

## 2. High-Level System Topology

```text
                              ┌────────────────────────────────────────────────┐
                              │         Users / Scientists / CI / CLI          │
                              └───────────────────────┬────────────────────────┘
                                                      │ HTTPS (TLS 1.3, Wildcard DNS-01 ACME)
                                                      ▼
          ┌────────────────────────────────────────────────────────────────────────────────┐
          │ Edge Reverse Proxy (Pre-built DNS-01 Caddy in dev; Global HTTPS LB in ent)     │
          │  • hub.<domain>                 → Hub UI & Control API (__Host-bionic_session) │
          │  • <prj-id>.editors.<domain>    → Hub Editor Proxy (__Host-bionic_editor_sess) │
          │  • <prj-id>.reports.<domain>    → Live Report Preview Proxy (isolated origin)  │
          │  • <pub-id>.reports.<domain>    → Authenticated Private/Org Published Reports  │
          │  • public-reports.<domain>      → /v<N>/* from static-reports-public GCS;      │
          │                                   /reports/*/latest* → Hub stateless 302       │
          └───────────────────────────────────────────┬────────────────────────────────────┘
                                                      │
                                                      ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                        BIONIC HUB (Modular Monolith Control Plane)                        │
│                                                                                           │
│  ┌────────────────────┐  ┌──────────────────────────┐  ┌───────────────────────────────┐  │
│  │ Auth, RBAC & CA    │  │ Project / Publish / Run  │  │ Declarative GitOps Admin API  │  │
│  │ • OIDC + PKCE SSO  │  │   Orchestrator           │  │ • Templates / Models          │  │
│  │ • CI OIDC / PATs   │  │ • CAS State Machine      │  │ • Skills / MCP Servers        │  │
│  │ • Subdomain Handoff│  │ • Operation Leases       │  │ • Schema + Policy + Rollback  │  │
│  │ • Internal mTLS CA │  │ • Grant-Verified Data    │  │ • Break-Glass Admin Bootstrap │  │
│  └────────────────────┘  └──────────────────────────┘  └───────────────────────────────┘  │
│                                                                                           │
│  ┌────────────────────┐  ┌──────────────────────────┐  ┌───────────────────────────────┐  │
│  │ mTLS Editor Proxy  │  │ Hub LLM Gateway          │  │ Hub MCP & Git Gateways        │  │
│  │ • HTTP / SSE / WS  │  │ • /llm/anthropic (native)│  │ • SSRF-Safe Remote MCP Proxy  │  │
│  │ • SAN=prj-id check │  │ • /llm/openai (compat)   │  │ • Central Git Smart HTTP Proxy│  │
│  │ • Shared LISTEN    │  │ • /llm/google (native)   │  │   (25MB & data/raw/ guard!)   │  │
│  │   Auto-Wake SSE    │  │ • AWS Bedrock (STS OIDC) │  │ • Read-Only Runner PyPI Proxy │  │
│  └─────────┬──────────┘  │ • Atomic Spend Reserve   │  └──────────────┬────────────────┘  │
│            │             └────────────┬─────────────┘                 │                   │
│  ┌─────────┴──────────────────────────┴───────────────────────────────┴────────────────┐  │
│  │ Workers (Postgres SKIP LOCKED): Compute Driver • 60s State Reconciler • Idle Reaper │  │
│  │ • GCP Orphan Sweeper (15m grace) • Public Purge Retrier • DB Housekeeping           │  │
│  └─────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────┬─────────────────────────────┬──────────────────────────┬───────────────┘
                   │                             │                          │
                   ▼                             ▼                          ▼
     ┌────────────────────────┐   ┌────────────────────────────┐   ┌────────────────────────┐
     │ PostgreSQL 16          │   │ Private VPC (Zero Pub IPs; │   │ Cloud Storage & Git    │
     │ • Config Revisions     │   │  Zero East-West Traffic)   │   │ • project-data (priv)  │
     │ • Projects / Leases    │   │                            │   │ • shared-datasets (RO) │
     │ • project_data_grants  │   │ ┌────────────────────────┐ │   │ • static-reports-priv  │
     │ • daily_llm_spend      │   │ │ Editor VM (prj-01...)  │ │   │ • static-reports-pub   │
     │ • Jobs & Audit Logs    │   │ │ 1) bionic-daemon.svc   │ │   │ • Git (Forgejo/GitHub) │
     └────────────────────────┘   │ │    (mTLS :3000/:3002,  │ │   │ • GCP Secret Manager   │
                                  │ │     shim 127.0.0.1:3001│ │   │ • Cloud NAT (Editor    │
                                  │ │     Zero root caps!)   │ │   │   subnet ONLY)         │
                                  │ │ 2) bioniceditor.svc    │ │   │ • No-Egress Runner     │
                                  │ │    (User=bionic-user,  │ │   │   Subnet (Zero NAT!)   │
                                  │ │     Unix sock / :3003) │ │   └────────────────────────┘
                                  │ │ • Persistent Disk (PD) │ │
                                  │ └────────────────────────┘ │
                                  └────────────────────────────┘
```

### Technology Stack
- **Hub Backend**: TypeScript + Node.js 22 LTS + Fastify (direct `http.Server` access for mTLS WebSocket proxying, low memory overhead, structured logging) + Drizzle ORM (`pg` with strict pool budgeting) + Zod schemas. Structured as logical modules (`control-plane`, `proxy-gateway`, `llm-gateway`, `mcp-gateway`, `git-gateway`, `workers`) deployable as one process in `dev` and horizontally separable in `enterprise`.
- **Hub Frontend**: React + Vite + Tailwind CSS (reusing Bionic Editor's semantic token & theme system).
- **VM Control Daemon (`hub/daemon/`)**: Standalone ~500-LOC TypeScript/Node service (`bionic-daemon.service`) baked into Packer images, running unprivileged as `bionic-daemon` with zero root capabilities.
- **Database**: PostgreSQL 16 (local Docker Postgres + nightly GCS `pg_dump` OR Cloud SQL in `dev`; HA Regional Cloud SQL + PgBouncer in `enterprise`).
- **Infrastructure**: Terraform (`infra/gcp/`) + Packer (`infra/packer/`) for Golden VM Images.

---

## 3. Repository & Module Layout

```text
bioniceditor/
├── server/                     # Existing Bionic Editor (minimal Hub Mode + Sandbox Mode hooks)
├── client/                     # Existing Bionic Editor UI (Hub Models, Publish, Isolated ReportViewer)
├── packages/
│   └── shared/                 # Shared Zod schemas & types (manifest v2, bionic.yaml, config YAML)
├── hub/
│   ├── daemon/                 # Unprivileged `bionic-daemon.service` (mTLS, attestation, shim :3001)
│   ├── server/
│   │   ├── index.ts            # Modular monolith entrypoint (role flags: all | api | proxy | worker)
│   │   ├── db/                 # Drizzle schema, migrations, pool budget, SKIP LOCKED queue, LISTEN hub
│   │   ├── auth/               # OIDC+PKCE, session store, subdomain handoff, CI OIDC, RBAC, mTLS CA
│   │   ├── proxy/              # mTLS HTTP/SSE/WS proxy, SAN check, live-report scope, auto-wake SSE
│   │   ├── gateways/
│   │   │   ├── llm/            # Native Anthropic/OpenAI/Gemini + AWS Bedrock + atomic spend reserve
│   │   │   ├── mcp/            # SSRF-hardened Remote HTTP/SSE MCP proxy + Mcp-Session-Id
│   │   │   ├── git/            # Central Git Smart HTTP proxy (scoped auth + 25MB/data-raw guard)
│   │   │   └── pypi/           # Read-only package proxy for no-egress Stage 1 Runner builds
│   │   ├── compute/            # ComputeProvider interface + GcpComputeProvider (direct GCE API)
│   │   ├── storage/            # Resumable GCS upload sessions, per-file V4 signed read URLs, grants
│   │   ├── git/                # Minimal 4-method GitProvider (ForgejoProvider, GitHubAppProvider)
│   │   ├── publish/            # Private vs Public publisher, stateless /latest 302, purge reconciler
│   │   ├── runner/             # 3-phase no-egress reproducible module execution orchestrator
│   │   ├── admin/              # GitOps Config API (templates, models, skills, mcp) + dry-run/rollback
│   │   └── workers/            # 60s state reconciler, idle reaper, GCP orphan sweeper, housekeeping
│   ├── client/                 # Bionic Hub Web App (Dashboard, Catalog, Publish, Runs, Admin)
│   └── cli/                    # `bionic-ctl` (optional thin CI wrapper for Admin GitOps API)
├── infra/
│   ├── gcp/                    # Platform Terraform (`profile = "dev" | "enterprise"`, Caddy DNS-01 Dockerfile)
│   ├── packer/                 # Golden VM Images (Ubuntu 24.04 + pinned OpenCode V2 + two-unit systemd)
│   └── config-examples/        # Example GitOps repo (templates/, models/, skills/, mcp/)
└── examples/
    └── demo-rnaseq-project/    # Self-contained bioinformatics analysis module + public website sandbox
```

---

## 4. Database Schema (PostgreSQL 16)

All IDs use RFC 1123 lowercase hyphenated ULIDs (`prj-<ulid>`, `pub-<ulid>`, `run-<ulid>`, `dat-<ulid>`, `usr-<ulid>`, `rev-<ulid>`). Secrets are **never** stored in plaintext in Postgres.

### 4.1 Identity, Auth, Subdomain Handoff & RBAC
- `users (id PK, email TEXT NOT NULL, email_verified BOOLEAN NOT NULL DEFAULT FALSE, display_name TEXT, oidc_sub TEXT NOT NULL, oidc_issuer TEXT NOT NULL, role ['admin'|'researcher'|'viewer'], status ['active'|'disabled'], created_at, last_login_at, UNIQUE(oidc_issuer, oidc_sub))` — partial unique index on `LOWER(email) WHERE status = 'active'` for invite/bootstrap lookup (requiring `email_verified = TRUE` before binding).
- `groups (id PK, slug UNIQUE, name, external_claim_value, created_at)`
- `group_memberships (group_id FK, user_id FK, PRIMARY KEY(group_id, user_id))`
- `user_sessions (id PK, token_hash UNIQUE, user_id FK, expires_at, ip_address, user_agent, created_at, revoked_at)`
- `editor_auth_codes (code_hash PK, user_id FK, parent_session_id FK, target_origin TEXT, scope ['editor'|'live_report'|'publication'], resource_id TEXT, expires_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ)` — 30-second single-use cross-origin handoff codes.
- `scoped_origin_sessions (id PK, token_hash UNIQUE, parent_session_id FK, user_id FK, scope ['editor'|'live_report'|'publication'], resource_id TEXT, target_origin TEXT, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)` — host-only subdomain session cookies invalidated atomically when `parent_session_id` logs out.
- `api_tokens (id PK, name, prefix, token_hash UNIQUE, created_by FK, scopes TEXT[], expires_at, last_used_at, revoked_at)`
- `ci_oidc_trust_policies (id PK, name UNIQUE, issuer TEXT, audience TEXT, subject_pattern TEXT, allowed_scopes TEXT[], enabled BOOLEAN, created_at)`

### 4.2 Versioned Admin Config Registries (GitOps)
- `config_revisions (id ['rev-<ulid>' PK], kind ['template'|'model'|'skill'|'mcp'], slug TEXT, version INT, content_yaml TEXT, parsed_json JSONB, content_sha256 TEXT, git_commit_sha TEXT, git_repo TEXT, status ['active'|'deprecated'|'disabled'], created_by TEXT, created_at, UNIQUE(kind, slug, version))`
- `templates (slug PK, active_revision_id FK REFERENCES config_revisions(id) ON DELETE RESTRICT, display_name, description, allowed_group_ids TEXT[], default_idle_timeout_min INT, max_idle_timeout_min INT, allowlisted_sa_email TEXT, updated_at)`
- `models (slug PK, active_revision_id FK REFERENCES config_revisions(id) ON DELETE RESTRICT, provider_type ['openai'|'anthropic'|'gemini'|'ollama'|'aws_bedrock'|'vertex'], protocol ['anthropic'|'openai'|'google'], display_name, allowed_group_ids TEXT[], enabled BOOLEAN, updated_at)`
- `skills (slug PK, active_revision_id FK REFERENCES config_revisions(id) ON DELETE RESTRICT, display_name, description, bundle_storage_uri TEXT, bundle_sha256 TEXT, allowed_group_ids TEXT[], enabled BOOLEAN, updated_at)`
- `mcp_servers (slug PK, active_revision_id FK REFERENCES config_revisions(id) ON DELETE RESTRICT, transport ['streamable_http'|'sse'|'stdio'], routing ['hub_gateway'|'vm_local'], allowed_group_ids TEXT[], enabled BOOLEAN, updated_at)`

### 4.3 Projects, Compute State, Leases & VM Attestation
- `projects`:
  - `id` (`prj-<ulid>` PK), `slug TEXT NOT NULL`, `name`, `description`, `state_version INT NOT NULL DEFAULT 1`
  - `owner_id` FK `users`, `template_slug` FK `templates`, `template_revision_id` FK `config_revisions(id) ON DELETE RESTRICT`
  - `parent_project_id` (nullable FK), `parent_publication_id` (nullable FK), `forked_from_commit_sha`
  - `git_repo_ref TEXT`, `git_default_branch TEXT DEFAULT 'main'`
  - `status` (`creating|provisioning|starting|running|freezing|frozen|stopping|stopped|resuming|archiving|archived|deleting|deleted|error`)
  - `desired_state` (`running|frozen|stopped|archived|deleted`), `status_message TEXT`
  - `transition_started_at TIMESTAMPTZ`, `pending_gcp_operation_id TEXT` (persisted for crash recovery)
  - `busy_operation TEXT`, `busy_until TIMESTAMPTZ` (operation lease preventing Publish vs Idle Reaper races)
  - `compute_provider`, `compute_zone`, `compute_instance_name TEXT`, `compute_instance_id TEXT`, `compute_internal_ip TEXT`, `compute_disk_name TEXT`, `compute_disk_size_gb INT`, `compute_snapshot_name TEXT`
  - `vm_cert_serial TEXT`, `vm_cert_expires_at TIMESTAMPTZ`, `vm_attested_at TIMESTAMPTZ`
  - `idle_timeout_minutes INT NOT NULL DEFAULT 20`, `last_activity_at TIMESTAMPTZ`, `frozen_at TIMESTAMPTZ`, `stopped_at TIMESTAMPTZ`
  - `data_bucket_prefix TEXT`, `pending_manifest_sync BOOLEAN DEFAULT FALSE`
  - `created_at`, `updated_at`
  - **Partial Unique Indexes**:
    - `UNIQUE (slug) WHERE status <> 'deleted'` (allows clean slug reuse after deletion)
    - `UNIQUE (compute_instance_name) WHERE status NOT IN ('deleted', 'archived')`
- `project_members (project_id FK, user_id FK, role ['owner'|'editor'|'viewer'], PRIMARY KEY(project_id, user_id))`

### 4.4 Authoritative Data Catalog, Grants, Publications & Reproducible Runs
- `data_objects (id ['dat-<ulid>' PK], scope ['shared'|'project'], owner_project_id nullable FK, storage_uri UNIQUE, gcs_generation TEXT, sha256 TEXT, crc32c TEXT, size_bytes BIGINT, filename TEXT, content_type TEXT, description TEXT, acquisition_json JSONB, status ['uploading'|'ready'|'deleted'], created_by FK, created_at)`
- `project_data_grants (project_id FK, data_object_id FK, permission ['read'|'read_write'], granted_via ['upload'|'vm_sync'|'fork'|'shared_link'], granted_at TIMESTAMPTZ, PRIMARY KEY(project_id, data_object_id))` — **sole authoritative source of data ACLs**.
- `pending_manifest_entries (id PK, project_id FK, data_object_id FK, target_rel_path TEXT, status ['pending'|'applied'|'failed'], created_at, applied_at)` — queues browser uploads completed while a VM is frozen/stopped.
- `publications (id ['pub-<ulid>' PK], project_id FK, version INT, title, summary, git_commit_sha TEXT, git_tag TEXT, template_slug FK, template_revision_id FK REFERENCES config_revisions(id) ON DELETE RESTRICT, storage_bucket_kind ['public'|'private'], static_site_url TEXT, artifact_storage_uri TEXT, manifest_snapshot_json JSONB, bionic_yaml_json JSONB, test_results_json JSONB, visibility ['private'|'org'|'public'], status ['publishing'|'ready'|'downgrading'|'deleted'], public_purge_pending BOOLEAN DEFAULT FALSE, published_by FK, published_at, updated_at, UNIQUE(project_id, version))`
- `publication_data_objects (publication_id FK, data_object_id FK, gcs_generation TEXT, rel_path TEXT, sha256 TEXT, PRIMARY KEY(publication_id, data_object_id))` — normalized dataset pinning preventing GCS GC from deleting published inputs and driving fast SQL grant copies on fork/reproduce.
- `runs (id ['run-<ulid>' PK], publication_id FK, source_project_id FK, git_commit_sha TEXT, template_slug FK, template_revision_id FK REFERENCES config_revisions(id) ON DELETE RESTRICT, status ['queued'|'building_env'|'hydrating'|'running'|'publishing'|'succeeded'|'failed'|'cancelled'|'timed_out'], compute_instance_name, pending_gcp_operation_id TEXT, output_publication_id nullable FK, logs_storage_uri TEXT, test_results_json JSONB, max_duration_sec INT, triggered_by FK, started_at, completed_at, created_at)`

### 4.5 Atomic Budgets, Usage, Jobs & Audit
- `daily_llm_spend (scope_key TEXT, utc_day DATE, spent_usd NUMERIC(12,6) NOT NULL DEFAULT 0, reserved_usd NUMERIC(12,6) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ, PRIMARY KEY(scope_key, utc_day))` — O(1) atomic budget reservation (`WHERE spent_usd + reserved_usd + $est <= $limit`) preventing parallel subagents/scripts from bypassing daily spend caps; stale reservations expire after 10 minutes via `llm_spend_reservations (id PK, scope_key, utc_day, amount_usd, expires_at)`.
- `llm_usage_events (id BIGSERIAL PK, project_id FK, user_id nullable FK, model_slug, provider_type, prompt_tokens INT, completion_tokens INT, cached_tokens INT, cost_usd NUMERIC(12,6), latency_ms INT, status_code INT, created_at)`
- `jobs (id PK, queue TEXT, job_type TEXT, payload_json JSONB, status ['pending'|'running'|'completed'|'failed'|'dead'], attempts INT, max_attempts INT, run_after TIMESTAMPTZ, locked_until TIMESTAMPTZ, locked_by TEXT, idempotency_key UNIQUE, last_error TEXT, created_at, updated_at)`
- `audit_logs (id BIGSERIAL PK, actor_user_id nullable, actor_token_id nullable, actor_ci_sub nullable, action TEXT, resource_type TEXT, resource_id TEXT, metadata_json JSONB, ip_address INET, created_at)`

### 4.6 Pool Budget, Shared `LISTEN` Hub & Housekeeping
- **Connection Pool Budget**: On Cloud SQL `db-f1-micro` (~25 max conns), cap pools explicitly: API/Proxy `max: 8`, Workers `max: 4`, Shared `LISTEN` listener `max: 1`, Admin/Migrations `max: 1` (total ≤ 14).
- **Single Shared `LISTEN` Connection**: One dedicated DB connection listens on `project_state_changes` and `session_revocations`, fanning out via an in-memory `EventEmitter` to all waiting Auto-Wake SSE tabs and the 20s Proxy Auth TTL cache (**zero DB connections per browser tab**).
- **Daily `db_housekeeping` Worker**: Purges expired `editor_auth_codes` (>1h), expired/revoked `user_sessions` & `scoped_origin_sessions` (>7d), completed `jobs` (>14d), stale `llm_spend_reservations`, and abandoned `data_objects` stuck in `'uploading'` > 7 days.

---

## 5. Security Architecture & Threat Model

### 5.1 Two-Unit OS Privilege Separation on Editor VMs (Zero `CAP_SETUID`, Zero `chown`)
Because Linux forbids non-root processes from calling `setuid()`/`chown()` (and granting `CAP_SETUID` is root-equivalent), every Editor VM splits cleanly into **two unprivileged systemd services** baked into the Packer image:

1. **`bionic-daemon.service` (`User=bionic-daemon`, `Group=bionic-daemon`, zero root capabilities)**:
   - Small, auditable control daemon (~500 LOC) that **never executes user/AI code or parses untrusted workspace files**.
   - Owns `/run/bionic-daemon/` (`0700 bionic-daemon:bionic-daemon`, `tmpfs`) holding the VM's mTLS private key, cert, and auto-refreshed 15-min Hub Workload JWT.
   - Terminates **Hub mTLS** on VPC `:3000` (Editor & Live Report traffic) and `:3002` (`/api/internal/*`).
   - Runs **`bionic-gateway-shim`** on `127.0.0.1:3001` proxying LLM, MCP, Git Smart HTTP, and Data Signed-URL calls to Hub using its auto-refreshed Workload JWT.
   - Syncs read-only admin skills to `/var/lib/bionic/managed-skills/<slug>/` (`0755/0644`).
   - Holds strictly scoped `sudoers` rules for exactly two fixed commands: `NOPASSWD: /usr/bin/chronyc makestep` and `NOPASSWD: /usr/local/libexec/bionic-remount-shared-data` (fixed path, no arguments).
   - `nftables` `meta skuid != bionic-daemon` blocks `bionic-user` from reaching `169.254.169.254` unless template explicitly sets `allowUserMetadataAdc: true` (and Hub never puts secrets in GCE instance metadata regardless).
2. **`bioniceditor.service` (`User=bionic-user`, `Group=bionic-user`, zero root capabilities)**:
   - Runs existing `bioniceditor` listening **only on Unix domain socket `/run/bionic-editor/app.sock` (`0660 bionic-user:bionic-daemon`) + `127.0.0.1:3003`** (unreachable from VPC!).
   - All workspace files, `opencode serve`, `/bin/bash`, `.venv`, and `git` run naturally as `bionic-user` with **zero `setuid` and zero `chown`**, and `BIONIC_API_URL=http://127.0.0.1:3003/api` works with zero mTLS conflict!
   - Even a full Express/Multer exploit in `bioniceditor` cannot read `/run/bionic-daemon/` mTLS keys or Hub Workload JWTs.
   - `server/config.ts` (`getTargetSpawnOptions`) enforces a strict env allowlist in Hub Mode instead of spreading `...process.env`.
3. **Honest Secret Classification**:
   - **Control-Plane Secrets** (Hub DB creds, mTLS CA key, LLM API keys / AWS Bedrock STS role, Hub MCP secrets, Git service tokens, VM mTLS private key, Hub Workload JWT): **Strictly unreachable by `bionic-user`**.
   - **Template Workload Secrets** (e.g., `NCBI_API_KEY` declared in a template's `secrets:` block): **Explicitly assumed readable by authorized `bionic-user` code inside that VM**—scoped solely to that template's domain, never cross-tenant.

### 5.2 Subdomain Origin Isolation & Host-Only Cookie Handoff
1. **Hub Origin (`hub.<domain>`)**: Sets `__Host-bionic_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`) after OIDC+PKCE login.
2. **Editor Origin (`<prj-id>.editors.<domain>`) — Single-Use Handoff**:
   - Unauthenticated request → redirects to `https://hub.<domain>/auth/handoff?scope=editor&resource=<prj-id>&next=/...`.
   - Hub verifies `__Host-bionic_session` + `project_members` (`owner` or `editor` ONLY; **`viewer` receives `403`** and is directed to Hub's read-only Git/file viewer and published reports!).
   - Hub creates a 30-second single-use code in `editor_auth_codes`, redirects to `https://<prj-id>.editors.<domain>/__bionic_auth/callback?code=...`.
   - Hub Editor Proxy intercepts `/__bionic_auth/callback` (never forwarded to VM), atomically consumes code, creates `scoped_origin_sessions` tied to `parent_session_id`, sets host-only `__Host-bionic_editor_session`, and redirects to `next`.
   - Hub logout revokes `user_sessions` + cascades to `scoped_origin_sessions` + broadcasts `NOTIFY session_revocations`.
3. **Live Report Preview Isolation (`<prj-id>.reports.<domain>`)**:
   - `bionic-daemon` **blocks `/report` on Editor origin requests** (`403`).
   - Requests arriving at `https://<prj-id>.reports.<domain>/*` pass through Hub Proxy with verified header `X-Bionic-Origin-Scope: live_report` (authenticated via `scope=live_report` host-only cookie); `bionic-daemon` serves **only read-only static files from `WORKSPACE_DIR/web-report/`** (strictly rejecting symlinks outside `web-report/`, zero `/api/*`, zero `/ws`).
   - `ReportViewer.tsx` loads `https://<prj-id>.reports.<domain>/index.html` inside `<iframe sandbox="allow-scripts allow-downloads allow-popups">`.
4. **Published Report Isolation**:
   - `visibility = 'public'` → `static-reports-public` GCS bucket behind `public-reports.<domain>`.
   - `visibility = 'org' | 'private'` → `static-reports-private` GCS bucket (zero public IAM) served on per-publication isolated origins `https://<pub-id>.reports.<domain>/...` (`scope=publication`), preventing cross-report XSS.

### 5.3 Deadlock-Free VM Attestation, Multi-Day Resume & mTLS Channel
1. **Hub Internal CA**: ECDSA P-256 CA (private key in GCP Secret Manager) issuing Hub Client Cert (`SAN=spiffe://bionic/hub`) and per-VM Server+Client Certs (`SAN=spiffe://bionic/project/<prj-id>`, `CN=<compute_instance_id>`, **72-hour TTL**, renewed at 24 hours).
2. **VM-Initiated Boot & Resume Attestation (Fixes Multi-Day Freeze Deadlock!)**:
   - `bionic-daemon` detects GCE suspend/resume deterministically by polling `CLOCK_BOOTTIME - CLOCK_MONOTONIC` every 1 second (any jump > 5s unambiguously signals resume from suspend).
   - On both cold boot AND detected resume, `bionic-daemon` proactively:
     1. Runs `sudo /usr/bin/chronyc makestep` (corrects VM clock skew immediately),
     2. Fetches a fresh Google-signed **GCE Instance Identity JWT** (`audience=https://hub.<domain>/attest`, `format=full`—minted with Google's clock),
     3. Generates/reuses keypair in `/run/bionic-daemon/` and calls `POST https://hub.<domain>/api/internal/vm/attest` with `{ identityJwt, csrPem }`.
   - Hub accepts attestation when `projects.status IN ('provisioning', 'starting', 'resuming', 'running')`, verifies Google's JWKS signature + `instance_id` + `instance_name` + `zone` + `project_id`, issues a fresh 72h cert + 15m Workload JWT, records `vm_attested_at = NOW()`, and broadcasts `NOTIFY`.
   - `bionic-daemon` hot-swaps TLS certificates in-process via `httpsServer.setSecureContext({ key, cert, ca })` with zero process restart!
   - Hub's `RESUMING`/`STARTING` orchestrator waits for `vm_attested_at >= transition_started_at` (or valid unexpired cert), **then** calls `POST /api/internal/post-resume` over fresh mTLS!
3. **mTLS on HTTP + Raw WebSocket `'upgrade'` + SAN Anti-Misrouting**:
   - `bionic-daemon` terminates mTLS (`requestCert: true, rejectUnauthorized: true`) on `:3000` (checking `SAN=spiffe://bionic/hub` + `Origin` on both HTTP and `'upgrade'`) and `:3002` (`/api/internal/*`).
   - Hub's reverse proxy verifies the VM's TLS server cert `SAN === spiffe://bionic/project/<prj-id>` on every connection, eliminating cross-tenant misrouting even if GCP reassigns an internal IP after `stop`/`start`.

### 5.4 Complete Threat Matrix

| Threat | Concrete Defense (v3) |
|---|---|
| **Subdomain Auth & Report XSS** | Host-only `__Host-` cookies per origin via 30s single-use handoff; `/report` blocked on Editor origin; `*.reports.*` isolated origins (`X-Bionic-Origin-Scope: live_report`) with `<iframe sandbox="allow-scripts allow-downloads allow-popups">`. |
| **VM Secret Theft / WS Bypass / Linux `setuid`** | Two-unit systemd split (`bionic-daemon` vs `bioniceditor` as `bionic-user`—zero `CAP_SETUID`, zero `chown`); strict env allowlist; mTLS on HTTP + WS `'upgrade'`; zero secrets in GCE metadata. |
| **Multi-Day Freeze mTLS Deadlock** | `CLOCK_BOOTTIME - CLOCK_MONOTONIC` resume detection → `chronyc makestep` → GCE Identity JWT re-attestation → `setSecureContext()` hot-swap before Hub calls `post-resume`. |
| **Private Report Exposure** | Split `static-reports-public` (public only) vs `static-reports-private` (zero public IAM, per-pub origin RBAC); durable `public_purge_pending` reconciler on visibility downgrade. |
| **Cross-Tenant GCS Data Oracle** | Authoritative `project_data_grants` + `publication_data_objects` tables in Postgres; publish validates every `manifest.json` URI against grants; forks/runs copy strictly from grants. |
| **Hub Control-Plane SSRF (MCP / Ollama)** | HTTPS-only default, DNS resolved before socket connect, redirects disabled, unconditionally blocks `169.254.0.0/16`, `127.0.0.0/8`, `::1`, Cloud SQL & Editor/Runner CIDRs; explicit `HUB_ALLOWED_PRIVATE_CIDRS` opt-in. |
| **GitOps Template / `stdio` MCP Escalation** | OS/packages baked in Packer; no raw root `startupScript` via HTTP API (non-root `workspaceInitHook` only); per-SA `iam.serviceAccounts.actAs` + default GCE SA disabled; `stdio` MCP hard-rejected on `hub_gateway`. |
| **Reproducible Runner Exfiltration** | Zero Cloud NAT on Runner subnet (`no-egress` from boot); 3-phase execution: Hub-proxied read-only PyPI → PyPI revoked + `bionic-run-build.slice` killed + daemon-side data hydration → `bionic-run-exec.slice` with zero internet & zero GCS access. |
| **Git Token Cross-Repo Leak** | All VM Git operations route through Hub's Central Git Smart HTTP Proxy (`127.0.0.1:3001/git/<prj-id>.git` → Hub), enforcing Workload JWT `project_id` + central 25 MB / `data/raw/` guard with zero Git credentials on VMs. |
| **Public Demo RCE (`handleDemoAgent`)** | `BIONIC_SANDBOX_MODE=true` hard-blocks `venv.ts`, `terminal.ts`, `opencodeServer.ts`, `/api/venv/*`, WS `terminal_start`, and `run_python` inside `handleDemoAgent` (`server/services/agent.ts:370`); gVisor/read-only-rootfs container with zero egress. |
| **Initial Break-Glass Admin Bootstrap** | `BIONIC_BOOTSTRAP_ADMIN_EMAIL` binds initial `admin` on first verified OIDC login (`email_verified = true`), or one-time bootstrap token printed to server logs and invalidated immediately on use. |

---

## 6. VM Image Templates & Admin GitOps Config API

### 6.1 Golden Image Factory & Retention Policy (`infra/packer/`)
- CI builds immutable, timestamp-versioned GCE Machine Images (e.g., `bionic-bio-standard-20261124-abc123`) into an image family (`bionic-bio-standard`).
- Every Packer image bakes: Ubuntu 24.04 LTS, Node 22, Python 3.12, `uv`, `git`, `gcsfuse`, `chrony`, `nftables`, **pinned `bioniceditor` release**, **pinned OpenCode V2 binary version** (preventing silent upstream config/API breaks), `bionic-daemon.service` + `bioniceditor.service`, `bionic-daemon`/`bionic-user` accounts, and domain packages (R/Bioconductor, samtools, CUDA).
- **Image Retention Guard**: Templates resolve families to immutable image self-links at publish time. Packer pruning queries `GET /api/v1/admin/images/in-use` and **never deletes images referenced by any active template, active project, or retained publication**.

### 6.2 Template YAML Specification (`templates/bio-standard.yaml`)
> **MVP Scope Simplification**: Platform infrastructure (VPC, subnets, Cloud NAT, Cloud SQL, GCS buckets, Secret Manager, Firewall rules, and per-template Service Accounts) is managed by **Terraform (`infra/gcp/`)**. Per-project VM provisioning uses **`direct_gce_api`** exclusively for Phases 1–5 (2-second provisioning, zero per-project Terraform state bloat, zero HCL injection risk). Optional `pinned_module` per-project Terraform is deferred to post-MVP Enterprise.

```yaml
apiVersion: bionic.io/v1
kind: ComputeTemplate
metadata:
  slug: bio-standard
  displayName: "Standard Bioinformatics Workstation"
  description: "4 vCPU, 16 GB RAM, Python 3.12 + R/Bioconductor"
  allowedGroups: ["researchers", "admins"]
compute:
  provider: gcp
  image: "projects/my-gcp-proj/global/images/bionic-bio-standard-20261124-abc123"
  machineType: "e2-standard-4"
  bootDiskGb: 30
  workspaceDiskGb: 100
  workspaceDiskType: "pd-balanced"
  suspendSupported: true
  idleTimeoutDefaultMinutes: 20
  idleTimeoutMaxMinutes: 180
iam:
  # Must match an admin-allowlisted SA created by infra/gcp Terraform with per-SA actAs grant
  serviceAccountEmail: "bionic-tmpl-bio-standard@my-gcp-proj.iam.gserviceaccount.com"
  allowUserMetadataAdc: false
secrets:
  # Template Workload Secrets (Secret Manager refs only — explicitly readable by bionic-user)
  - name: NCBI_API_KEY
    source: "gcp-sm://projects/my-gcp-proj/secrets/ncbi-api-key/versions/latest"
    mount: env
workspaceInitHook:
  # Non-root script executed ONLY as bionic-user inside workspace on first project creation
  enabled: true
  script: |
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Workspace initialized for bio-standard"
```

### 6.3 Models, Skills & MCP Config-as-Code Specs
- **Models (`models/*.yaml`)**: `provider: openai | anthropic | gemini | ollama | aws_bedrock | vertex`, `protocol: anthropic | openai | google`, AWS Bedrock auth via **GCP-to-AWS OIDC Workload Identity Federation (`aws_sts_web_identity`)** or `secret_ref`, `allowedGroups`, `dailyBudgetUsdPerUser`, `dailyBudgetUsdPerProject`, and `pricing`.
- **Skills (`skills/<slug>/SKILL.md` + `skill.yaml`)**: Uploaded via `bionic-ctl apply` as content-addressed `.tar.gz` bundles in private GCS (`bundle_storage_uri`, `bundle_sha256`). `bionic-daemon` extracts read-only into `/var/lib/bionic/managed-skills/<slug>/` (`0755/0644`, outside `WORKSPACE_DIR` so never committed to Git!), and `bioniceditor` refreshes symlinks in `~bionic-user/.config/opencode/skills/` on `sync-config`.
- **MCP Servers (`mcp/<slug>.yaml`)**: `transport: streamable_http | sse | stdio`; `routing: hub_gateway` (mandatory for remote servers using Hub secrets; **hard-rejects `stdio`**!) or `vm_local` (`stdio` only using binaries pre-baked in Packer, zero Hub secrets). `hub_gateway` preserves `Mcp-Session-Id`, enforces SSRF blocking, group RBAC, and audit logging.

### 6.4 Declarative Admin API & `bionic-ctl` CI Workflow
- Auth: CI OIDC Workload Identity (`ci_oidc_trust_policies`, e.g. GitHub Actions OIDC restricted to `repo:org/bionic-config:ref:refs/heads/main`) OR scoped Admin PAT.
- Endpoints: `POST /api/v1/admin/config/apply?dryRun=true|false`, `PUT /api/v1/admin/config/:kind/:slug`, `POST /api/v1/admin/config/:kind/:slug/rollback`, `GET /api/v1/admin/config/:kind`, `GET /api/v1/admin/images/in-use`.
- **Propagation**: Templates are **pinned per project** (`projects.template_revision_id`) until upgraded; Models, Skills, and MCP configs propagate **live** to running VMs (`POST /api/internal/sync-config` + 5-min pull fallback) for immediate revocation or skill rollout.

---

## 7. Centralized LLM Gateway (Basic Providers + AWS Bedrock)

### 7.1 Native Multi-Protocol Gateway (Full Feature Fidelity)

| Hub Gateway Route | Target Providers | Streaming & Feature Fidelity |
|---|---|---|
| `POST /llm/anthropic/v1/messages` | Direct Anthropic API **AND** AWS Bedrock Claude models (`InvokeModelWithResponseStream` with native Anthropic `anthropic_version: bedrock-2023-05-31`) | Preserves extended `thinking` blocks + signatures, `cache_control` prompt caching, tool calling, and token usage. |
| `POST /llm/openai/v1/chat/completions` & `/llm/openai/v1/responses` | OpenAI, Ollama/vLLM, **AND** AWS Bedrock non-Claude models (Amazon Nova, Meta Llama, Mistral via `ConverseStreamCommand`) | Preserves SSE deltas, tool calls, and token usage. |
| `POST /llm/google/v1beta/models/:model:*` | Google Gemini API & Vertex AI | Preserves Gemini streaming, thinking, and cached tokens. |

### 7.2 Daemon-Tracked User Attribution & Atomic Spend Enforcement
Because `opencode serve` is a single long-lived process that does not forward per-turn custom headers to LLM providers:
1. Hub's Editor Proxy sends verified `X-Bionic-User-Id` on every proxied request to `bionic-daemon`.
2. Whenever `bionic-daemon` proxies `POST /api/agent/chat`, it records `{ activeUserId, updatedAt }` in daemon RAM (unwritable by `bionic-user`).
3. On every outbound LLM call through `bionic-gateway-shim` (`127.0.0.1:3001`), `bionic-daemon` strips any client-supplied attribution header and attaches its daemon-tracked `X-Bionic-Triggering-User` (defaulting to `project.owner_id` if no recent chat turn) alongside the VM's cryptographic Workload JWT.
4. **Hub-Side Verification & Atomic Budget Reserve**:
   - Hub verifies `X-Bionic-Triggering-User` is an active `owner`/`editor` member of the Workload JWT's `project_id` before checking `model.allowedGroups`.
   - Hub atomically reserves an upper-bound cost estimate in `daily_llm_spend` (`WHERE spent_usd + reserved_usd + $est <= $limit`), streams upstream chunks directly, and settles `(spent_usd += actual, reserved_usd -= $est)` on stream completion (eliminating parallel subagent budget bypass races).
   - *(Multi-user concurrency note)*: Project-level spend attribution is 100% exact; in rare concurrent multi-editor turns inside one VM, per-user attribution reflects the most recent prompt triggerer.

---

## 8. Large-Scale Data Storage Architecture

### 8.1 Three-Tier Storage Model
1. **Tier 1 — Object Storage Data Lake (GCS / S3)**:
   - `gs://<org>-shared-datasets/` (read-only institutional references, mounted via `gcsfuse` at `/mnt/shared-data` with local disk cache).
   - `gs://<org>-project-data/projects/<prj-id>/blobs/<dat-ulid>/<filename>` (**Object Versioning enabled**, immutable per upload — never overwrites datasets pinned by prior publications).
2. **Tier 2 — Per-Project Persistent Workspace Disk (GCE PD `pd-balanced`)**:
   - Mounted at `/var/lib/bionic/workspace`. Holds Git tree, `.venv/`, `data/processed/`, `figures/`, `web-report/`, and hydrated `data/raw/` files. Resizable online; UI alerts at 80%/90% full.
3. **Tier 3 — Project Git Repository (via Hub Central Git Smart HTTP Proxy)**:
   - Small text/code/plan/manifest files only. All VM Git traffic routes through `bionic-daemon` (`127.0.0.1:3001/git/<prj-id>.git`) → Hub (`https://hub.<domain>/api/internal/git/<prj-id>.git`), where Hub verifies `jwt.project_id === :prjId` and centrally rejects blobs > 25 MB or paths under `data/raw/` before forwarding to Forgejo (`dev`) or GitHub App (`enterprise`). Zero Git tokens ever touch the VM!

### 8.2 Multi-GB/TB Data Flows
1. **Direct Browser Resumable Upload (Zero Hub RAM, 7-Day Resume Window)**:
   - Editor UI calls Hub `POST /api/v1/projects/:id/data/upload-session` → Hub creates `data_objects` (`status='uploading'`) targeting `projects/<prj-id>/blobs/<dat-ulid>/<filename>`, initiates a **GCS Resumable Upload Session URI server-side** (valid up to 7 days), and returns `{ dataObjectId, resumableSessionUri }`.
   - Bucket CORS allows `PUT` with `origin: ["*"]` (safe for cookieless, unguessable single-object capability URIs). Browser streams chunks directly to GCS while computing streaming SHA-256 in a **Web Worker**.
   - On `upload-complete`, Hub verifies authoritative GCS metadata (`size`, `generation`, `crc32c`), marks `status='ready'`, inserts `project_data_grants`, and either notifies `bionic-daemon` to register `syncStatus: 'remote_only'` in `data/manifest.json` (if `RUNNING`) or queues in `pending_manifest_entries` (if `FROZEN`/`STOPPED`).
   - **Multer Guardrail**: In Hub Mode, `bioniceditor`'s legacy `POST /api/files/upload` is capped at **25 MB** and rejects `data/raw/*` uploads (`400`, directing clients to GCS resumable upload).
2. **Agent-Downloaded Data (`scripts/data-push.sh`) & Eviction**:
   - Plain bash script (`curl` + `sha256sum` + `python3` stdlib) that streams local `data/raw/` files to GCS via `$BIONIC_DATA_PROXY_URL` inside Hub (reporting `activeDataTransfers > 0` while uploading) OR via standard `gcloud storage cp` / `aws s3 cp` when a coder runs outside Hub (`BIONIC_DATA_BUCKET` env var). Supports `--evict-local` to reclaim PD space once synced (`syncStatus: 'remote_only'`).
3. **On-Demand Hydration & Zero-Copy Forking (`scripts/data-pull.sh`, No CAB 10-Rule Limit)**:
   - Plain bash script reading `data/manifest.json`: inside Hub, calls `$BIONIC_DATA_PROXY_URL/read-url` to obtain a short-lived **per-file V4 Signed Read URL** (authorized strictly against Postgres `project_data_grants` and pinned to `gcs_generation`), streams with `curl`, and verifies `sha256sum`. Outside Hub (exported project), falls back seamlessly to `gcloud storage cp` / `aws s3 cp` / `curl` (from `storage.uri` or `acquisition.sourceUrl`) or runs `acquisition.scriptPath`, then verifies `sha256sum`.
   - Forking copies `project_data_grants` rows (`permission='read'`) from `publication_data_objects` in milliseconds—zero data duplication and zero cross-tenant oracle risk.

### 8.3 `DataManifestEntry` v2 Schema Extension
Backwards-compatible extension to `server/services/dataManifest.ts`: adds optional `storage: { provider, dataObjectId, uri, generation, crc32c, syncStatus: 'synced' | 'pending' | 'remote_only', readOnly }`. `getManifestSummary()` and `verifyManifest()` validate `remote_only` and `/mnt/shared-data` entries against Hub's `data_objects` metadata instead of throwing `Path is outside workspace` or `missing`.

---

## 9. Publishing & Self-Contained Reproducible Analysis Modules

A finished project is a **self-contained, reproducible analysis module** combining its **published `web-report/`**, pinned **Git code & plans**, **portable bash workflow scripts (`scripts/`)**, immutable **data references (`publication_data_objects` + `data/manifest.json`)**, and **compute template revision**.

### 9.1 Portable Project Scripts (`scripts/` — No Hidden Magic, Zero Lock-In)
Every new project workspace scaffolds five small, readable, standard bash scripts inside `scripts/` (automatically hidden in Scientist View and revealed in Coding Mode per Bionic Editor's File Explorer rules). Any coder who clones or exports a project onto a laptop, HPC cluster, or external CI runner has **100% of the same functionality** using standard CLI tools (`bash`, `curl`, `python3` stdlib, `git`, `sha256sum`, plus `gcloud`/`aws`/`rsync` when standalone):

| Script | Responsibility | Inside Bionic Hub | Exported / Standalone (Coder Laptop or CI) |
|---|---|---|---|
| `scripts/data-pull.sh` | Hydrate raw datasets from `data/manifest.json` & verify `sha256sum` | Calls `$BIONIC_DATA_PROXY_URL` (`127.0.0.1:3001`) for per-file V4 Signed Read URLs; no-ops if already present with matching SHA-256 | Uses `gcloud storage cp` / `aws s3 cp` / `curl` (from `storage.uri` or `acquisition.sourceUrl`) or runs `acquisition.scriptPath`, then verifies `sha256sum` |
| `scripts/data-push.sh` | Upload new `data/raw/*` files & record `storage.uri` (`--evict-local` optional) | Streams via `$BIONIC_DATA_PROXY_URL` resumable upload session | Uploads via `gcloud storage cp` / `aws s3 cp` to `$BIONIC_DATA_BUCKET` |
| `scripts/verify-data.sh` | Hard pre-publish & CI safety check | Verifies `web-report/index.html`, checks `git ls-files -- data/raw/`, checks SHA-256 integrity, scans `web-report/` for escaping symlinks, raw bio extensions, oversized files, and raw hash matches | Exact same standalone check (zero Hub dependency!) |
| `scripts/run.sh` | End-to-end reproducible execution | Invoked by `bionic.yaml` (`["bash", "scripts/run.sh"]`) in the 3-phase no-egress runner (creates/activates `.venv`, verifies data, runs `code/` pipeline + `pytest tests/scientific/`, builds `web-report/`) | Coder runs `./scripts/run.sh` directly after `git clone` (auto-creates `.venv` from `uv.lock`/`requirements.txt`, pulls data if missing, runs full pipeline + tests + report) |
| `scripts/publish.sh` | Full publish workflow | Invoked when scientist clicks **Publish** in Bionic Editor UI: runs `./scripts/verify-data.sh` → `./scripts/data-push.sh` → Git commit/tag/push → `tar`s `web-report/` and `curl`s `$BIONIC_HUB_PUBLISH_URL` (`127.0.0.1:3001/publish`) | Coder sets `PUBLISH_TARGET` (`gcs://...`, `s3://...`, `rsync://...`, `gh-pages`, or local dir `./dist-report`) and runs `./scripts/publish.sh` (supports `--no-git` and `--dry-run`) |

### 9.2 Analysis Module Manifest (`bionic.yaml`)
```yaml
schemaVersion: 1
name: "kidney-cohort-deg-analysis"
environment:
  pythonLockfile: "uv.lock"        # Preferred deterministic lockfile (falls back to requirements.txt)
  rLockfile: "renv.lock"           # Optional
entrypoint:
  # Strict argv array (NEVER shell-interpolated!) — delegates directly to portable scripts/run.sh
  argv: ["bash", "scripts/run.sh"]
  workdir: "."
outputs:
  reportDir: "web-report"
  testResultsGlob: "tests/scientific/*_results.json"
```

### 9.3 Publish Operation (`scripts/publish.sh` + Zero-Trust Hub Server Gate) & Export
Clicking **Publish** in Bionic Editor runs the workspace's own **`./scripts/publish.sh`** (so scientists and coders execute the exact same transparent workflow and any project-specific pre-publish build steps are preserved). Because the Editor VM is untrusted compute, Hub still enforces every security invariant server-side at intake:

1. **Operation Lease**: Hub acquires `SELECT ... FOR UPDATE` on `projects`, asserts `status = 'running'` and no conflicting lease, sets `busy_operation = 'publish:' || pubId`, `busy_until = NOW() + INTERVAL '5 minutes'`, and bumps `last_activity_at = NOW()` (returning `409 Conflict` if `freezing`/`stopping`). Releases lease in `finally`.
2. **VM-Side Portable Execution (`./scripts/publish.sh`)**:
   - Runs `./scripts/verify-data.sh` (immediate fast feedback to user in UI if `web-report/index.html` is missing or a leak exists), syncs any pending `data/raw/` via `./scripts/data-push.sh`, commits & tags `pub/v<N>` via Hub Git Proxy, and streams a tarball of `web-report/` + `git_commit_sha` + `manifest.json` via `curl` to `$BIONIC_HUB_PUBLISH_URL` (`127.0.0.1:3001/publish` → Hub `POST /api/internal/projects/:id/publish-intake`).
3. **Server-Side Zero-Trust Intake Gate (Never Trusts the VM!)**:
   - Even if a compromised VM modified `scripts/publish.sh` to skip checks, Hub's `publish-intake` independently verifies:
     - `git_commit_sha` exists on the project's Git repo (already guarded by Hub Git Proxy's 25 MB / `data/raw/` check),
     - Every `data/manifest.json` `storage.uri`/`dataObjectId` is authorized in Postgres `project_data_grants` (blocks forged cross-tenant URIs!) and `syncStatus === 'synced'`,
     - The uploaded `web-report/` archive contains zero symlinks, zero raw bio extensions, zero oversized files, and zero SHA-256 matches against `data_objects`.
   - Records normalized rows in `publication_data_objects`.
4. **Atomic Static Site Deployment**:
   - `public` → `static-reports-public` (`reports/<project-slug>/v<N>/`, `Cache-Control: public, max-age=31536000, immutable`).
   - `org` / `private` → `static-reports-private` (served via `https://<pub-id>.reports.<domain>/`).
   - **Atomic `/latest` Redirect**: A single edge route on `public-reports.<domain>` forwards `/reports/*/latest*` to Hub's stateless redirect handler (`GET /_public/reports/:slug/latest`, 20s cache + `NOTIFY` invalidation), returning `302 Found` → `/reports/<slug>/v<N>/` with `Cache-Control: no-store`.
   - **Visibility Downgrade Safety**: Downgrading `public → private/org` sets `status = 'downgrading'`, `public_purge_pending = TRUE`, copies to `static-reports-private`, deletes all `static-reports-public` objects, invalidates CDN, and clears `public_purge_pending` (retried by reconciler until verified deleted).
5. **Module & Report Download**: `GET /api/v1/publications/:pubId/download?format=report|module` streams an RBAC-gated `.zip` of `web-report/` or the full standalone reproducible bundle (`git archive` including `scripts/*.sh`, `bionic.yaml`, and `data/manifest.json` — ready for any coder to unzip and run `./scripts/run.sh` or `./scripts/publish.sh` locally).

### 9.4 Forking & Three-Phase No-Egress Reproduction Runs (`POST /api/v1/publications/:pubId/runs`)
From any completed analysis module's catalog page, authorized users can:
1. **View Published Report** (or download standalone report/module bundle),
2. **Create Interactive Project from Module ("Fork")**: Creates `prj-<ulid>`, clones `git_commit_sha`, uses `template_revision_id`, copies read-only grants from `publication_data_objects`, and opens Bionic Editor, OR
3. **Reproduce Headlessly ("Run Module")**:
   - **Auth Gate**: User must have read access to the publication, membership in the template's `allowedGroups` (or run with zero-privilege `bionic-runner-noiam-sa`), and verified read grants on `publication_data_objects`.
   - **Zero Cloud NAT on Runner Subnet**: Runner VMs boot **directly** in the `no-egress` subnet (sole egress: `Hub internal IP:443`, plus IMDS restricted by `nftables` to `bionic-daemon` only—eliminating `instances.setTags` races and GCS public-write exfiltration completely!).
   - **Phase 1 — `building_env` (Zero Private Data on Disk)**: `bionic-user` inside `bionic-run-build.slice` checks out `git_commit_sha` via Hub Git Proxy and installs `uv.lock`/`requirements.txt` via Hub's **read-only PyPI/Artifact Registry proxy** (`https://hub.<domain>/api/internal/runs/:runId/pypi`).
   - **Phase 2 — `hydrating` (Hard Process Barrier + Daemon-Side Hydration)**: Hub **revokes** the run's PyPI proxy permission. `bionic-daemon` stops `bionic-run-build.slice` (killing every Stage 1 process/background `setup.py` daemon!). **`bionic-daemon` itself** pulls pinned raw datasets via Hub-proxied GCS streams, verifies SHA-256, and writes them read-only (`0444`) into `data/raw/`.
   - **Phase 3 — `running` (Zero Internet & Zero GCS Egress for `bionic-user`)**: `bionic-daemon` launches `entrypoint.argv` (default `["bash", "scripts/run.sh"]`, where `scripts/data-pull.sh` detects the hydrated files already match SHA-256 and skips network calls!) inside `bionic-run-exec.slice` as `bionic-user` with strict `max_duration_sec` (enforced by watchdog + GCE `scheduling.maxRunDuration`, max 2h). Streams logs to Hub/GCS (`logs_storage_uri`, private to run owner), collects `tests/scientific/*_results.json`, runs server-side leak checks, optionally publishes a verified reproduction artifact, supports cancellation (`POST /api/v1/runs/:runId/cancel`), and **unconditionally destroys the ephemeral VM** in a `finally` reconciler job.

---

## 10. Distributed State Machine, Idle Lifecycle & Crash Recovery

### 10.1 Concurrency, Thundering Herd & Crash-Safe Transitions
- Every state change runs inside a Postgres `SELECT ... FOR UPDATE` transaction, increments `state_version`, and emits `NOTIFY project_state_changes`.
- **Thundering Herd Auto-Wake**: Concurrent browser tabs visiting a `FROZEN`/`STOPPED`/`ARCHIVED` project race on `SELECT ... FOR UPDATE`: the first transitions `frozen → resuming` and enqueues a job with **versioned idempotency key** `wake:<prj-id>:v<state_version>` (preventing duplicate wakes AND allowing unlimited future freeze/wake cycles). All other tabs see `status = 'resuming'` and subscribe to Hub's **shared `LISTEN` in-memory `EventEmitter`** SSE stream (0 DB connections per tab!).
- **Crash-Safe GCE Writes**: Hub persists deterministic `compute_instance_name = <prj-id>`, `compute_disk_name = pd-<prj-id>`, and `transition_started_at = NOW()` **before** calling `instances.insert`, and persists `pending_gcp_operation_id` immediately on every GCE LRO.
- **60-Second State Reconciler Worker**: Scans transitional states (`creating|provisioning|starting|freezing|stopping|resuming|archiving|deleting`) stuck > 3 minutes, queries `pending_gcp_operation_id` and live GCE instance status, and converges Postgres to reality (recovering automatically from Hub crashes mid-provision, mid-freeze, or mid-delete).
- **GCP Orphan Sweeper (Every 15m)**: Labels every VM/PD with `bionic-managed=true`, `bionic-hub-id=<hub-id>`, `bionic-project-id=<prj-id>` (or `bionic-run-id=<run-id>`). Destroys unmanaged GCP resources **only if `creationTimestamp` is > 15 minutes old** AND DB row is missing or `deleted` (never reaping actively booting VMs).

### 10.2 Whole-UID Idle Detection & Tiered Freeze Lifecycle
- **Composite Activity Signals** (timeout defaults to **20 minutes**, configurable per project up to `template.max_idle_timeout_min`):
  1. Authenticated non-heartbeat HTTP/SSE/WS traffic through Hub Editor Proxy, OR
  2. `bionic-daemon`'s `GET /api/internal/activity` reports:
     - `activeAgentTurns > 0` or `activeSubagents > 0`,
     - `activeDataTransfers > 0`, OR
     - **`activeComputeProcs > 0`**: inspects **all processes owned by `bionic-user`** (`ps -u bionic-user` + `bioniceditor.service` cgroup) outside an explicit idle allowlist (`bioniceditor`, `opencode`, idle `/bin/bash`, idle `tmux: server` with no active pane children)—preventing false freezes during `nohup`, `tmux`, Snakemake, or PyTorch jobs!
- **Freeze Race Guard**: Idle Reaper queries `status = 'running' AND (busy_until IS NULL OR busy_until < NOW()) AND last_activity_at < NOW() - make_interval(mins => idle_timeout_minutes)`, transitions to `freezing`, runs `POST /api/internal/prepare-freeze` (session flush + best-effort 15s Git autosave skipping files > 5 MB), then performs a **final CAS check** (`WHERE id = $1 AND status = 'freezing' AND state_version = $expected`) before calling GCE `suspend`/`stop`—aborting cleanly if a user resumed interaction or clicked Publish during those 15s!
- **Tiered Spindown**:
  - `idle > T_idle` (default 20m): GCE `suspend` (`FROZEN`, ~15–25s resume) if `suspendSupported: true`, else clean `stop` (`STOPPED`, ~35–55s resume).
  - `FROZEN > 7 days`: Auto-demote to `STOPPED` (well under GCP's 60-day suspend cap; reclaims RAM snapshot storage).
  - `STOPPED > 30–90 days` (optional): Snapshot PD + delete active disk (`ARCHIVED`, ~$0.026/GB-mo); auto-restores disk seamlessly on reopen.
- **Post-Resume Sequence**: After VM wakes, `bionic-daemon` runs `chronyc makestep` + re-attests fresh mTLS cert (`§5.3`) → Hub refreshes `compute_internal_ip` → Hub calls `POST /api/internal/post-resume` over fresh mTLS (remounts stale `gcsfuse` if `ESTALE`/`EIO`, reconnects `opencodeServer` SSE, applies `pending_manifest_entries` + `sync-config`) → transitions to `RUNNING`.

---

## 11. Required Changes to Existing Bionic Editor (`server/` & `client/`)

Because `bionic-daemon.service` handles mTLS, attestation, Origin checks, `/report` blocking, and localhost JWT proxying, changes to existing `bioniceditor` stay remarkably small and clean:

1. **Hub Mode & Env Allowlist (`server/config.ts`, `server/index.ts`)**:
   - In `BIONIC_HUB_MODE=true`, bind strictly to Unix socket (`/run/bionic-editor/app.sock`) + `127.0.0.1:3003` (never `0.0.0.0`); use strict env allowlist in `getTargetSpawnOptions()`; disable wildcard `cors()`; disable `POST /api/agent/save-config` and client-supplied `apiKey`/`baseUrl` (`403`); cap Multer `POST /api/files/upload` at **25 MB** and reject `data/raw/*` uploads (`400`).
   - Emit `: keepalive\n\n` SSE heartbeats every 15s on `/api/agent/chat` and decouple background OpenCode turns from `res.on('close')` so proxy/tab disconnects never kill running analyses (cancel strictly via `POST /api/agent/cancel`).
2. **Workspace Control Endpoints (`server/routes/hubLocal.ts`)**:
   - Local-only routes called by `bionic-daemon` over the Unix socket: `/api/hub-local/activity`, `/api/hub-local/prepare-freeze`, `/api/hub-local/apply-manifest`, `/api/hub-local/sync-config` (refreshes `~bionic-user/.config/opencode/skills/` symlinks and `.opencode/opencode.jsonc`).
3. **Dynamic Hub Models & OpenCode Config (`server/services/opencodeConfig.ts`, `server/services/opencodeServer.ts`, `client/src/components/SettingsModal.tsx`)**:
   - Write Hub-provisioned model/provider blocks in `.opencode/opencode.jsonc` pointing `baseURL` at `http://127.0.0.1:3001/llm/{anthropic,openai,google}` with `BIONIC_LOCAL_SHIM_TOKEN`.
   - Hide raw API key inputs in `SettingsModal.tsx` when `BIONIC_HUB_MODE=true`; load model selector dynamically from `GET /api/models`.
4. **Data Manifest v2 & Portable Project Scripts (`server/services/dataManifest.ts`, `server/services/workspace.ts`, `client/`)**:
   - Scaffold portable bash scripts (`scripts/run.sh`, `scripts/publish.sh`, `scripts/data-pull.sh`, `scripts/data-push.sh`, `scripts/verify-data.sh`) in `initDefaultTemplate()` (already hidden in Scientist View and shown in Coding Mode!).
   - Support `storage.syncStatus: 'remote_only' | 'synced' | 'pending'` and `/mnt/shared-data` entries; wire `data/raw/` browser uploads to Hub's GCS Resumable Upload Session flow + Web Worker SHA-256.
5. **Sandbox Lockdown (`BIONIC_SANDBOX_MODE=true`)**:
   - Hard-block `venv.ts`, `terminal.ts`, `opencodeServer.ts`, `/api/venv/*`, WS `terminal_start`, AND **`run_python` inside `handleDemoAgent` (`server/services/agent.ts:370`)**.
6. **UI Additions (`client/src/App.tsx`, `client/src/components/WebReport/ReportViewer.tsx`)**:
   - Load `<prj-id>.reports.<domain>/index.html` with `sandbox="allow-scripts allow-downloads allow-popups"` in Hub Mode; add Hub breadcrumb, idle countdown badge, and **Publish** modal with pre-flight leak summary.

---

## 12. GCP Terraform Architecture & Public Website Demo Project

### 12.1 Personal GCP Test & Enterprise Terraform (`infra/gcp/`)
A single Terraform root with `profile = "dev" | "enterprise"` and `db_mode = "local_docker" | "cloud_sql"`:

| Component | `profile = "dev"` (Personal GCP Test: ~$35–$55/mo idle, ~2m apply) | `profile = "enterprise"` |
|---|---|---|
| **Networking** | Custom VPC, Editor subnet + Cloud NAT, **Zero-NAT No-Egress Runner subnet**, strict firewalls (zero public IPs on VMs, deny east-west VM traffic) | Multi-zone VPC, Private Service Connect, Cloud Armor WAF, optional egress proxy |
| **Bionic Hub & TLS** | Single `e2-medium` (4 GB RAM) GCE VM w/ static IP running Hub + **pre-built DNS-01 Caddy Dockerfile** (`caddy-dns/googleclouddns` & `cloudflare`) serving `hub.*`, `*.editors.*`, `*.reports.*`, AND `public-reports.*` (zero LB/CDN floor cost!) | GKE Autopilot or MIG behind Global External HTTPS LB + Cloud CDN (NOT Cloud Run — preserves long-lived WS/SSE & background workers!) |
| **PostgreSQL** | `db_mode = "local_docker"` (default in `dev`: Postgres 16 container on PD + nightly GCS `pg_dump`) OR `cloud_sql` (`db-f1-micro`, 14-conn budget) | `db_mode = "cloud_sql"` HA Regional Postgres (`db-custom-4-16384`) + PITR + PgBouncer |
| **Git Server** | Dedicated Forgejo service OR GitHub App (both behind Hub's Central Git Smart HTTP Proxy!) | GitHub Enterprise / GitLab App or HA Forgejo |
| **Auth IdP** | Google Cloud OAuth 2.0 OIDC (2-minute zero-cost personal setup) | Enterprise OIDC (Okta, Entra ID, Google Workspace, Keycloak) |
| **GCS Buckets** | 4 buckets: `project-data` (private, versioned), `shared-datasets` (RO), `static-reports-private` (private), `static-reports-public` (public) | Same + CMEK, Cloud CDN, VPC-SC, retention policies |
| **IAM & Secrets** | GCP Secret Manager; default GCE SA disabled; `hub-control-plane-sa` granted `roles/iam.serviceAccountUser` strictly per-template SA | Same + AWS OIDC Workload Identity Federation for Bedrock |

### 12.2 Public Website Example & Interactive Sandbox (`examples/demo-rnaseq-project/`)
1. **Self-Contained Showcase Analysis Module ("Pan-Cohort Differential Gene Expression & Pathway Analysis")**:
   - Complete reproducible workspace: 5-section `SPEC.md`, `plans/pathway_enrichment.md`, `code/analyze.py`, portable `scripts/{run.sh,publish.sh,data-pull.sh,data-push.sh,verify-data.sh}`, ~4 MB public/synthetic RNA-seq dataset with `data/manifest.json` + `data/DATA_MANIFEST.md`, passing `tests/scientific/test_deg_panel.py` + results JSON, `bionic.yaml`, and an interactive Plotly `web-report/index.html`.
2. **Two-Tier Safe Public Hosting**:
   - **Tier A — Anonymous Website Playground**:
     - Visitors browse the **Bionic Hub Showcase** (published interactive report, Git code browser, `data/manifest.json` SHA-256 provenance, `bionic.yaml`, scientific test pass/fail results) and click **"Open Sandbox Copy"** to launch an ephemeral Copy-on-Write workspace running `BIONIC_SANDBOX_MODE=true` inside a **gVisor / read-only-rootfs container with zero network egress**, 15-min TTL, and strict CPU/RAM caps.
     - **Zero shell/Python execution** (`handleDemoAgent`'s `run_python` disabled). AI chat runs a rich **Guided Scientific Demo Assistant** (zero cost, demonstrates Markdown-first edits & subagent cards) plus optional Cloudflare Turnstile-gated **"Live AI Trial"** (strict IP cap: 5 turns/day on `gemini-2.5-flash` with max output tokens).
   - **Tier B — Allowlisted Full Cloud Evaluation**:
     - Invited reviewers sign in via Google OIDC allowlist to experience real GCE VM provisioning, live OpenCode + Python `.venv`, large GCS uploads, idle freeze/resume, and real publishing.

---

## 13. Phased Implementation Roadmap

- **Phase 1: Core Hub Control Plane, Schema, Auth, Subdomain Handoff & Editor Hub/Sandbox Modes**
  - `packages/shared/` schemas, Drizzle migrations (with partial unique indexes, FKs, `publication_data_objects`, `daily_llm_spend`), pool-budgeted Postgres + shared `LISTEN` hub, OIDC+PKCE (`email_verified` + `(oidc_issuer, oidc_sub)`), break-glass admin bootstrap, host-only subdomain handoff.
  - `hub/daemon/` (`bionic-daemon.service`) + minimal Bionic Editor `BIONIC_HUB_MODE=true` (Unix socket/loopback bind, env allowlist, 25 MB Multer cap, SSE heartbeats, decoupled turns) and `BIONIC_SANDBOX_MODE=true` (`handleDemoAgent` RCE patch).
- **Phase 2: GCP Terraform (`dev`/`enterprise`) + Packer Golden Images + Compute & Idle Lifecycle**
  - `infra/gcp/` Terraform (with pre-built DNS-01 Caddy Dockerfile, `local_docker`/`cloud_sql`, Editor + Zero-NAT Runner subnets) and `infra/packer/` Golden VM Image (two-unit systemd, pinned OpenCode V2, `nftables`, `chrony`, `gcsfuse`).
  - VM-initiated boot/resume GCE Identity attestation → 72h mTLS cert + `setSecureContext()`, `GcpComputeProvider`, mTLS reverse proxy with SAN check + live-report scope, versioned-key auto-wake SSE, 60s State Reconciler, whole-UID idle reaper with CAS lease guard, and 15m-grace GCP Orphan Sweeper.
- **Phase 3: GitOps Admin API, Native Multi-Protocol LLM Gateway (incl. AWS Bedrock) & MCP Gateway**
  - Declarative YAML Config API + `bionic-ctl` + CI OIDC auth + Packer image-in-use protection.
  - Hub LLM Gateway (`/llm/anthropic`, `/llm/openai`, `/llm/google` + AWS Bedrock native Anthropic & Converse streaming + OIDC STS auth + daemon-tracked user attribution + atomic `daily_llm_spend` reservations).
  - SSRF-hardened Hub MCP Gateway (`streamable_http`/`sse`, `Mcp-Session-Id`) + live VM config & outside-Git skill sync.
- **Phase 4: Large Data Storage, Portable `scripts/` & Central Git Smart HTTP Proxy**
  - `data_objects`, `project_data_grants`, `pending_manifest_entries`, 7-day GCS Resumable Upload Session URIs with Web Worker SHA-256, portable bash `scripts/{data-pull.sh,data-push.sh,verify-data.sh}` (working both via Hub shim and standalone `gcloud`/`aws`/`curl`), `gcsfuse` shared mounts, `DataManifestEntry` v2.
  - Hub Central Git Smart HTTP Proxy (`ForgejoProvider` + `GitHubAppProvider`) with JWT `project_id` isolation and central 25 MB / `data/raw/` pre-receive enforcement.
- **Phase 5: Portable `scripts/publish.sh` + Zero-Trust Publishing & Three-Phase No-Egress Reproducible Module Runner**
  - Scaffold `scripts/publish.sh` & `scripts/run.sh` (works identically on a coder's laptop/CI via `PUBLISH_TARGET` or inside Hub via `$BIONIC_HUB_PUBLISH_URL`), operation-leased Hub `publish-intake` with independent server-side leak & grant verification, split `static-reports-public` / `static-reports-private`, stateless `/reports/*/latest` `302` handler, `public_purge_pending` reconciler, and `/download?format=report|module`.
  - Three-phase no-egress reproducible module runner (`building_env` via Hub PyPI proxy → `hydrating` cgroup kill + daemon-side data pull → `running` zero-egress `bash scripts/run.sh`) + interactive module forking.
- **Phase 6: Public Website Showcase Module, Sandbox Deployment & Security Verification**
  - Build `examples/demo-rnaseq-project/`, gVisor anonymous sandbox deployment, end-to-end security/chaos/crash-recovery test suite, and deployment guides.

---

## Appendix A: Architecture Review Changelog

### Iteration 1 Review Resolutions (Principal Cloud & Security Architect)
- **C1 (Subdomain Auth & Report XSS)**: Replaced shared `__Host-` cookie assumption with 30s single-use cross-origin handoff (`editor_auth_codes` → `scoped_origin_sessions`), blocked `/report` on Editor origin, isolated live previews on `<prj-id>.reports.<domain>` with `<iframe sandbox>`.
- **C2 (VM Auth & Secret Isolation)**: Replaced `vm_auth_secret_hash` + GCE metadata secrets with GCE Instance Identity attestation + mTLS CA; replaced `...process.env` spread with strict env allowlist; authenticated raw WS `'upgrade'`; classified Control-Plane vs Template Workload secrets honestly.
- **C3 (Private Report Exposure)**: Split into `static-reports-public` and `static-reports-private` buckets with per-publication origins (`<pub-id>.reports.<domain>`).
- **C4 (Cross-Tenant GCS Oracle)**: Added authoritative `project_data_grants` Postgres table validated at publish and copied strictly on fork.
- **C5 (15m JWT Expiry & Hardcoded Providers)**: Added `bionic-daemon` localhost shim (`127.0.0.1:3001`) for transparent JWT refresh; planned dynamic Hub model/provider config in `opencodeConfig.ts` & `opencodeServer.ts`.
- **C6 (Illegal DNS Underscores)**: Switched canonical IDs to RFC 1123 lowercase hyphenated ULIDs (`prj-<ulid>`, `pub-<ulid>`, `run-<ulid>`).
- **H1–H7 & M1–M5**: Added Hub SSRF egress firewall; removed raw root `startupScript` via API + per-SA `actAs` + blocked `stdio` on `hub_gateway`; redesigned large data around 7-day GCS Resumable Upload URIs + per-file V4 Signed Read URLs + `DataManifestEntry` v2 `remote_only`; patched `handleDemoAgent` `run_python` RCE via `BIONIC_SANDBOX_MODE=true`; added native Anthropic/Bedrock streaming, SSE keepalives + decoupled turns, `viewer` RBAC guard, `db-f1-micro` pool budget, outside-Git skill sync, and break-glass admin bootstrap.

### Iteration 2 Review Resolutions (Staff Distributed Systems & Cloud Infrastructure Architect)
- **C1 (Multi-Day Freeze mTLS Deadlock)**: Added `CLOCK_BOOTTIME - CLOCK_MONOTONIC` resume detection inside `bionic-daemon` → locked-down `sudo chronyc makestep` → fresh GCE Instance Identity JWT re-attestation (allowed in `provisioning|starting|resuming|running`) → 72h cert hot-swapped via `setSecureContext()` before Hub calls `post-resume`.
- **C2 (Linux Non-Root `setuid`/`chown` Impossibility)**: Split VM into two unprivileged systemd units (`bionic-daemon.service` as `bionic-daemon` owning mTLS & `:3001` shim; `bioniceditor.service` as `bionic-user` on Unix socket / `127.0.0.1:3003`)—zero `CAP_SETUID`, zero `chown`, zero `BIONIC_API_URL` mTLS conflict, tiny TCB.
- **C3 (Stage 1 `setup.py` Exfiltration & Tag-Swap Race)**: Eliminated Cloud NAT on Runner subnet & dynamic `instances.setTags`; replaced with 3-phase no-egress execution (Hub read-only PyPI proxy → PyPI revoked + `bionic-run-build.slice` killed + daemon-side data hydration → `bionic-run-exec.slice` with zero internet & zero GCS access).
- **C4 (Publish vs. Idle Reaper Race)**: Added `busy_operation` + `busy_until` lease on `projects`, `409 Conflict` guard on transitioning states, and post-`prepare-freeze` `state_version` CAS check before GCE `suspend`.
- **C5 (`X-Bionic-Triggering-User` Through `opencode serve`)**: Tracked verified `activeUserId` inside `bionic-daemon` RAM on proxied `POST /api/agent/chat`, stripped client headers in shim, and verified project membership on Hub before model RBAC & budgets.
- **H1–H5 & M1–M3 + MVP Simplifications**: Added versioned wake idempotency keys (`wake:<prj-id>:v<state_version>`), single shared `LISTEN` SSE fan-out, crash-safe pre-insert GCE names + `pending_gcp_operation_id` + 60s State Reconciler + 15m-grace Orphan Sweeper; routed `/reports/*/latest*` through Hub stateless `302` handler (GCS lacks native 302); added Central Git Smart HTTP Proxy (eliminating VM Git tokens & Forgejo single-repo token gap); fixed 7 Postgres schema gaps (partial unique indexes, `UNIQUE(oidc_issuer, oidc_sub)`, revision FKs, `publication_data_objects`, `public_purge_pending`, atomic `daily_llm_spend` reservations, `db_housekeeping`); streamlined `dev` GCP deployment (`e2-medium` + pre-built DNS-01 Caddy + optional `local_docker` DB = ~$35–$55/mo idle, ~2m apply); deferred per-project `pinned_module` Terraform runner to post-MVP Enterprise; upgraded idle detection to whole-UID `bionic-user` process inspection; pinned OpenCode V2 version in Packer; added `/download?format=report|module`, 25 MB Hub Multer cap, and `X-Bionic-Origin-Scope: live_report`.
