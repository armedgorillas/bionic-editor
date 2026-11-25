# Bionic Hub — GCP Infrastructure Requirements & Installation Guide

This document specifies the **exact GCP infrastructure requirements**, **runtime configuration**, and **installation steps** needed to deploy **Bionic Hub** into an existing GCP project / company Terraform repository.

> **Reference Implementation:** A standalone reference Terraform implementation is available in `infra/gcp/` and a Packer image template in `infra/packer/`. Use them as reference examples when integrating these resources into your existing Terraform modules.

---

## 1. GCP Infrastructure Requirements Checklist

Provision the following resources in your GCP project before installing the Bionic Hub application.

### 1.1 Required GCP APIs
Enable these APIs on the target GCP project:
- `compute.googleapis.com` (Editor & Runner GCE VMs, persistent disks, snapshots)
- `iam.googleapis.com` & `cloudresourcemanager.googleapis.com` (Service Accounts & per-SA IAM bindings)
- `secretmanager.googleapis.com` (OIDC secret, LLM provider keys, MCP secrets, optional DB password)
- `storage.googleapis.com` (4 isolated GCS buckets)
- `dns.googleapis.com` (Private split-horizon DNS zone for internal `hub.<domain>` resolution; plus DNS-01 ACME if using Cloud DNS)
- `sqladmin.googleapis.com` & `servicenetworking.googleapis.com` *(only if using Cloud SQL for PostgreSQL)*

### 1.2 Networking, Subnets, Private DNS & Firewalls

Bionic Hub requires **strict network isolation** because Editor and Runner VMs execute AI-generated Python/R/bash code:

1. **Subnets (in your VPC):**
   - **Hub Control Plane subnet** (hosts Bionic Hub + TLS reverse proxy; Private Google Access enabled).
   - **Editor VMs subnet** (e.g., `bionic-editors-subnet`, `/20` recommended; Private Google Access enabled; **NO external/public IPs** on VMs; outbound internet via **Cloud NAT**).
   - **Reproducible Runner VMs subnet** (e.g., `bionic-runners-noegress-subnet`, `/20` recommended; **NO external/public IPs** AND **NO Cloud NAT** — zero arbitrary internet egress).
2. **Firewall Rules (using GCE network tags `bionic-hub-server`, `bionic-editor-vm`, `bionic-runner-noegress`):**
   - **Ingress to Hub (`bionic-hub-server`):** Allow TCP `80`, `443` from your load balancer / allowed corporate CIDRs / `0.0.0.0/0`.
   - **Hub → Editor VMs (`bionic-editor-vm`):** Allow ingress TCP `3000` (Editor + Live Report mTLS) and `3002` (internal lifecycle mTLS) **strictly from `bionic-hub-server`** (source tag or Hub subnet CIDR).
   - **Editor & Runner VMs → Hub (`bionic-hub-server`):** Allow ingress TCP `443` from Editor and Runner subnet CIDRs (for VM attestation, LLM/MCP/Git/Data gateways). Do **not** expose plaintext port `4000` to VPC subnets.
   - **Deny East-West VM Traffic (`priority: 900`):** Explicit `DENY all` ingress between Editor and Runner subnet CIDRs targeting `bionic-editor-vm` and `bionic-runner-noegress`.
   - **Runner Zero-Egress (`bionic-runner-noegress`):**
     - `ALLOW` egress TCP `443` (`priority: 800`) **only** to the Hub subnet CIDR.
     - `DENY` egress `all` (`priority: 950`) to `0.0.0.0/0`.
3. **Private Split-Horizon Cloud DNS Zone (Required):**
   - Create a private Cloud DNS zone for `${domain}.` attached to the VPC with an `A` record resolving **`hub.${domain}.`** to the Hub reverse proxy's **internal VPC IP**.
   - *Why:* Zero-NAT Runner VMs cannot reach external IPs, and Editor VMs avoid hairpinning LLM/Git/data traffic through paid Cloud NAT.

### 1.3 Public DNS & Wildcard TLS (Strict Origin Isolation)
Point the following DNS records to your HTTPS edge proxy / Global External HTTPS Load Balancer:
- `hub.<domain>` → Hub UI & Control Plane API
- `*.editors.<domain>` → Authenticated per-project Editor proxy (`<prj-id>.editors.<domain>`)
- `*.reports.<domain>` → Isolated live previews (`<prj-id>.reports.<domain>`) & private/org publications (`<pub-id>.reports.<domain>`)
- `public-reports.<domain>` → Published reports static site:
  - **Demo Deployment (`HUB_PUBLIC_REPORTS_REQUIRE_AUTH=true`):** Route **all** traffic on `public-reports.<domain>` to Bionic Hub (`127.0.0.1:4000`). Keep the `GCP_STATIC_PUBLIC_BUCKET` GCS bucket **strictly private (`public_access_prevention = "enforced"`, zero `allUsers` IAM)** — Hub authenticates every visitor via its host-only subdomain handoff (`__Host-bionic_report_session`) and streams static assets from GCS using Hub's Service Account.
  - **Enterprise Client Deployment (`HUB_PUBLIC_REPORTS_REQUIRE_AUTH=false`):** The client secures their own static site (Cloud IAP / Cloud Armor / corporate CDN / VPN). Route `/reports/*/latest*` to Hub (`GET /_public/reports/:slug/latest*`) and serve immutable `/reports/*/v*/*` directly from the client's static site bucket.

> **Important (Reverse Proxy Requirements):**
> - Wildcard TLS certificates (`*.editors.<domain>`, `*.reports.<domain>`) require **DNS-01 ACME** (or managed wildcard certs on Cloud LB). See `infra/gcp/caddy/Dockerfile` and `infra/gcp/caddy/Caddyfile` for a ready-to-use Caddy reference.
> - **Do NOT deploy Bionic Hub on Cloud Run** — Cloud Run enforces a 60-minute request timeout (killing long-lived WebSocket terminals & SSE turns), lacks wildcard subdomain routing, and throttles background worker loops. Deploy on a GCE VM (`e2-medium` min for dev/test), Managed Instance Group (MIG), or GKE.

### 1.4 IAM Service Accounts & Least-Privilege Bindings
Create separate Service Accounts (disable/avoid using the default Compute Engine SA):

| Service Account | Purpose | Required IAM Permissions |
|---|---|---|
| `bionic-hub-control-plane` | Attached to Bionic Hub host/pods | • `roles/compute.instanceAdmin.v1` on project<br>• `roles/secretmanager.secretAccessor` on project (or specific secrets)<br>• `roles/storage.objectAdmin` on the 4 Bionic GCS buckets<br>• `roles/iam.serviceAccountUser` granted **STRICTLY per-resource** on each allowlisted template SA and `bionic-runner-noiam` (**NEVER project-wide!**)<br>• `roles/dns.admin` *(only if Caddy uses Cloud DNS for DNS-01 ACME)* |
| `bionic-tmpl-<name>` *(e.g. `bionic-tmpl-bio-standard`)* | Attached to Editor VMs created from a compute template | • `roles/storage.objectViewer` on `shared-datasets` bucket only<br>• Any domain-specific read roles intentionally granted to that template class<br>• **Zero** `compute.*`, `iam.*`, or `project-data` bucket-wide IAM |
| `bionic-runner-noiam` | Fallback zero-privilege SA for headless reproduction runs | • **Zero** project-level IAM roles |

### 1.5 GCS Buckets (4 Strictly Separated Buckets)
All buckets should enable `uniform_bucket_level_access = true`:

| Bucket Purpose | Env Var | Public Access | Special Settings |
|---|---|---|---|
| **Project Raw Data** | `GCP_PROJECT_DATA_BUCKET` | `enforced` (Private) | **Object Versioning enabled**; CORS allowing `PUT, POST, GET, HEAD, OPTIONS` from `["https://hub.<domain>"]` with response headers `Content-Type, Content-Range, Range, Location, x-goog-resumable` |
| **Shared Institutional Datasets** | `GCP_SHARED_DATA_BUCKET` | `enforced` (Private) | Mounted read-only via `gcsfuse` at `/mnt/shared-data` on Editor VMs |
| **Private & Org Published Reports** | `GCP_STATIC_PRIVATE_BUCKET` | `enforced` (Private) | **Zero** `allUsers`/`allAuthenticatedUsers` bindings; served strictly through Hub on `<pub-id>.reports.<domain>` |
| **Published Reports Site** | `GCP_STATIC_PUBLIC_BUCKET` | **Demo:** `enforced` (Private — zero `allUsers`, proxied through Hub)<br>**Enterprise:** Client-managed static site security | Receives published site reports (`visibility = "public"`). In demo mode, keep `public_access_prevention = "enforced"` and set `HUB_PUBLIC_REPORTS_REQUIRE_AUTH=true` so all publication buckets stay behind authentication. |

### 1.6 PostgreSQL 16 Database
- **Requirement:** PostgreSQL 16 reachable over private IP from Bionic Hub (either existing company Cloud SQL Postgres with `ssl_mode = "ENCRYPTED_ONLY"` + Private Service Access peering, or a dedicated Postgres 16 container on persistent storage with nightly `pg_dump` backups to GCS).
- **Connection Budget:** Hub uses two pools (`DB_API_POOL_MAX`, default `8`, and `DB_WORKER_POOL_MAX`, default `4`) plus `1` dedicated `LISTEN/NOTIFY` connection (~14 total connections per Hub replica).
- **Schema:** Managed automatically by `node hub/dist/server/db/migrate.js` (`hub/server/db/migrations/001_initial_schema.sql`).

### 1.7 Secret Manager & Persistent Cryptographic Keys
1. **OIDC SSO Client (Google Workspace / Okta / Entra ID / Keycloak):**
   - Redirect URI: `https://hub.<domain>/api/v1/auth/oidc/callback`
   - Store the OIDC client secret in GCP Secret Manager (e.g., `bionic-oidc-client-secret`) and reference it via `OIDC_CLIENT_SECRET_REF=gcp-sm://projects/<project>/secrets/bionic-oidc-client-secret/versions/latest`.
2. **Model Provider / MCP Secrets (in Secret Manager):**
   - Store API keys (e.g., `bionic-gemini-api-key`, `bionic-openai-api-key`, `bionic-anthropic-api-key`) in Secret Manager and reference them via `gcp-sm://...` inside your GitOps `models/*.yaml` and `mcp/*.yaml` files.
   - For **AWS Bedrock**, either configure **GCP-to-AWS OIDC Workload Identity Federation** (`auth.type: aws_sts_web_identity` trusting the `bionic-hub-control-plane` SA — zero static AWS keys) OR store AWS keys in Secret Manager (`auth.type: aws_secret_ref`).
3. **Persistent Hub Internal CA & Ed25519 JWT Signing Keys (CRITICAL):**
   - Hub must retain the **same** Internal ECDSA P-256 CA (`ca.crt`/`ca.key`) and Ed25519 Workload JWT keypair (`jwt-ed25519.key`/`jwt-ed25519.pub`) across restarts and across all Hub replicas so running Editor VMs never lose mTLS/JWT authentication.
   - Generate once and store in Secret Manager (or persistent volume):
     ```bash
     openssl ecparam -name prime256v1 -genkey -noout -out ca.key
     openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
       -subj "/CN=Bionic Hub Internal CA/O=Bionic Hub" -out ca.crt
     openssl genpkey -algorithm ED25519 -out jwt-ed25519.key
     openssl pkey -in jwt-ed25519.key -pubout -out jwt-ed25519.pub
     ```
4. **Git Storage Backend:**
   - Either point `HUB_GIT_PROVIDER=forgejo` + `HUB_GIT_UPSTREAM_URL` + `HUB_GIT_SERVICE_TOKEN` at an internal Forgejo/Gitea instance, OR mount a persistent disk directory at `HUB_GIT_LOCAL_DIR` (`HUB_GIT_PROVIDER=local`). All Editor VM Git traffic routes through Hub's Central Git Smart HTTP Proxy (zero Git tokens on VMs).

---

## 2. Hub Runtime Environment Variables

Configure these environment variables on the Bionic Hub server container/service (parsed in `hub/server/config.ts`):

| Variable | Required | Example / Notes |
|---|---|---|
| `NODE_ENV` | Yes | `production` |
| `HUB_ID` | Yes | Unique hub identifier used to label managed GCE VMs (e.g., `bionic-hub-prod`) |
| `HUB_HOST` | Yes | `127.0.0.1` (behind TLS reverse proxy; never expose plaintext `4000` publicly) |
| `HUB_PORT` | Yes | `4000` |
| `HUB_DOMAIN` | Yes | `bionic.company.com` (Hub fails closed if unset in production) |
| `DATABASE_URL` | Yes | `postgres://bionic:<pw>@<pg-ip>:5432/bionic_hub?sslmode=require` |
| `DB_SSL_MODE` | Recommended | `require` (for Cloud SQL `ENCRYPTED_ONLY`) or `disable` (local socket/docker) |
| `HUB_COMPUTE_PROVIDER` | Yes | `gcp` |
| `GCP_PROJECT_ID` | Yes | Target GCP project ID (also strictly verified on GCE VM attestation!) |
| `GCP_DEFAULT_ZONE` | Yes | `us-central1-a` |
| `GCP_EDITOR_SUBNET` | Yes | Name of Editor subnet (e.g., `bionic-editors-subnet`) |
| `GCP_RUNNER_SUBNET` | Yes | Name of Zero-NAT Runner subnet (e.g., `bionic-runners-noegress-subnet`) |
| `GCP_PROJECT_DATA_BUCKET` | Yes | Name of private versioned project data bucket |
| `GCP_SHARED_DATA_BUCKET` | Optional | Name of read-only shared datasets bucket |
| `GCP_STATIC_PUBLIC_BUCKET` | Yes | Name of public published reports bucket |
| `GCP_STATIC_PRIVATE_BUCKET` | Yes | Name of private/org published reports bucket |
| `HUB_ALLOWLISTED_SAS` | Yes | Comma-separated allowlist of pre-provisioned Template SA emails |
| `GCP_RUNNER_NOIAM_SA` | Recommended | Email of `bionic-runner-noiam` SA |
| `HUB_BLOCKED_CIDRS` | Yes | Comma-separated internal CIDRs blocked from SSRF (e.g., `10.42.0.0/16` / your VPC CIDR) |
| `HUB_ALLOWED_PRIVATE_CIDRS` | Optional | Explicit internal CIDRs allowed for internal MCP/Ollama servers |
| `OIDC_ISSUER` | Enterprise | e.g., `https://accounts.google.com` or Okta/Entra issuer URL (optional in Demo mode if using local auth only) |
| `OIDC_CLIENT_ID` | Enterprise | OIDC application client ID |
| `OIDC_CLIENT_SECRET_REF` | Enterprise | `gcp-sm://projects/<proj>/secrets/bionic-oidc-client-secret/versions/latest` (or `OIDC_CLIENT_SECRET`) |
| `HUB_LOCAL_AUTH_ENABLED` | Demo Only | `true` for the demo version (enables Admin manual user invites + email/password setup); **`false` in enterprise** |
| `HUB_PUBLIC_REPORTS_REQUIRE_AUTH` | Demo Only | `true` for the demo version (forces Hub authentication on `public-reports.<domain>` so the GCS publication bucket has zero public access); `false` when client secures static site |
| `BIONIC_BOOTSTRAP_ADMIN_EMAIL` | Yes | Admin email granted initial `admin` role (via verified OIDC login, or local login when paired with `BIONIC_BOOTSTRAP_ADMIN_PASSWORD`) |
| `BIONIC_BOOTSTRAP_ADMIN_PASSWORD` | Demo Only | Initial admin password (min 12 chars) auto-bootstrapped once on startup when `HUB_LOCAL_AUTH_ENABLED=true` |
| `HUB_INTERNAL_CA_CERT_FILE` | Yes | Path to `ca.crt` (or `HUB_INTERNAL_CA_CERT_PEM`) |
| `HUB_INTERNAL_CA_KEY_FILE` | Yes | Path to `ca.key` (or `HUB_INTERNAL_CA_KEY_PEM`) |
| `HUB_JWT_PRIVATE_KEY_FILE` | Yes | Path to `jwt-ed25519.key` (or `HUB_JWT_PRIVATE_KEY_PEM`) |
| `HUB_JWT_PUBLIC_KEY_FILE` | Yes | Path to `jwt-ed25519.pub` (or `HUB_JWT_PUBLIC_KEY_PEM`) |
| `HUB_GIT_PROVIDER` | Yes | `forgejo` or `local` |
| `HUB_GIT_UPSTREAM_URL` | If `forgejo` | Internal Forgejo base URL |
| `HUB_GIT_SERVICE_TOKEN` | If `forgejo` | Service token for Forgejo |
| `HUB_GIT_LOCAL_DIR` | If `local` | Persistent directory path (e.g., `/srv/bionic-hub/git`, never `/tmp`) |
| `HUB_LOCAL_STORAGE_DIR` | Recommended | Persistent scratch directory (e.g., `/srv/bionic-hub/storage`) |

---

## 3. Step-by-Step Software Installation

Once the GCP resources in Section 1 are provisioned by your Terraform repo, install and bootstrap Bionic Hub as follows.

### Step 1: Build & Push the Bionic Hub Container Image
From the root of this repository:
```bash
# Build Hub server + Hub Web UI + shared schemas + DB migrations
docker build -f hub/Dockerfile -t <your-artifact-registry>/bionic-hub:latest .
docker push <your-artifact-registry>/bionic-hub:latest
```
The container entrypoint automatically runs idempotent PostgreSQL migrations (`node hub/dist/server/db/migrate.js`) and then starts `node hub/dist/server/index.js` on `HUB_HOST:HUB_PORT` (healthcheck endpoint: `GET /healthz`).

### Step 2: Build & Publish the Golden Editor VM Image (Packer)
Editor VMs require a GCE Machine Image containing:
- Ubuntu 24.04 LTS, Node.js 22, Python 3.12, `uv`, `git`, `gcsfuse`, `chrony`, `nftables`, OpenCode V2
- Two unprivileged OS accounts (`bionic-daemon` and `bionic-user`) with `nftables` blocking GCE IMDS (`169.254.169.254:80`) for all UIDs except `root` and `bionic-daemon`
- Built `bioniceditor` (`/opt/bioniceditor`) + built `bionic-daemon` (`/opt/bionic-hub`)
- Four systemd units (`bionic-vm-bootstrap.service`, `bionic-mount-shared-data.service`, `bionic-daemon.service`, `bioniceditor.service`)

Package the local artifacts and run Packer (pointing at your existing VPC/subnet):
```bash
# 1. Package Bionic Editor and Bionic Daemon tarballs
npm ci && npm --prefix client ci && npm run build && npm pack
mv bioniceditor-*.tgz bioniceditor.tgz

npm --prefix packages/shared ci && npm --prefix packages/shared run build
npm --prefix hub ci && npm --prefix hub run build
tar -czf bionic-hub-daemon.tgz -C hub package.json package-lock.json dist

# 2. Build the GCE image into your GCP project
cd infra/packer
packer init bionic-bio-standard.pkr.hcl
packer build \
  -var "project_id=<YOUR_GCP_PROJECT_ID>" \
  -var "zone=<YOUR_ZONE>" \
  -var "network=<YOUR_VPC_NAME>" \
  -var "subnetwork=<YOUR_EDITOR_SUBNET_NAME>" \
  bionic-bio-standard.pkr.hcl
```
Record the resulting immutable GCE image self-link (or family `projects/<proj>/global/images/family/bionic-bio-standard`).

### Step 3: Start Bionic Hub & Verify Health
Deploy the `bionic-hub` container behind your reverse proxy / Load Balancer with the environment variables from Section 2 (reference Docker Compose layout: `infra/gcp/docker-compose.yml`).

Verify:
```bash
curl -fsS https://hub.<domain>/healthz
# Expected: {"ok":true,"hubId":"...","role":"all"}
```

### Step 4: Bootstrap Initial Admin, Invite Demo Users & Mint a CI GitOps Token
1. **Sign in as Initial Admin:**
   - **Demo Mode (`HUB_LOCAL_AUTH_ENABLED=true`):** Sign in at `https://hub.<domain>` with `BIONIC_BOOTSTRAP_ADMIN_EMAIL` and `BIONIC_BOOTSTRAP_ADMIN_PASSWORD`.
   - **Enterprise Mode (OIDC):** Sign in via SSO using the `BIONIC_BOOTSTRAP_ADMIN_EMAIL` account.
2. **Manually Add Demo Users (Demo Mode Only):**
   - Open the **Admin** tab → **Demo Users** panel (or call `POST /api/v1/admin/users/invite` with `{ "email": "alice@example.com", "displayName": "Alice", "role": "researcher" }`).
   - Copy the generated 72-hour single-use password setup URL (`https://hub.<domain>/?setupToken=...&email=...`) and send it to the user.
   - When the user opens the link, they set a password (min 12 characters, stored hashed with per-user salted `scrypt`) tied to their email and are signed in immediately. They can also view authenticated reports on `https://public-reports.<domain>` via automatic Hub session handoff.
3. **Mint a Scoped CI Admin PAT (`bht_...`) for GitOps Syncing:**
   ```bash
   curl -fsS -X POST https://hub.<domain>/api/v1/admin/tokens \
     -H "Cookie: __Host-bionic_session=<your-session-cookie>" \
     -H "Origin: https://hub.<domain>" \
     -H "Content-Type: application/json" \
     -d '{"name":"gitops-ci","scopes":["config:read","config:write"],"expiresInDays":90}'
   ```
   *(Alternatively, insert a row in `ci_oidc_trust_policies` to authenticate GitHub Actions / GitLab CI via keyless OIDC JWTs.)*

### Step 5: Sync Templates, Models (incl. AWS Bedrock), Skills & MCP via GitOps
Copy `infra/config-examples/` into your version-controlled config repository, update `project_id`, `serviceAccountEmail`, image link, secret refs, and remove/update `mcp/pubmed-search.yaml` to point to a real resolvable MCP host.

Run a dry-run diff, then apply:
```bash
BIONIC_HUB_URL="https://hub.<domain>" \
BIONIC_ADMIN_TOKEN="<bht_... token>" \
node hub/dist/cli/bionic-ctl.js apply --dir <your-config-dir> --dry-run

BIONIC_HUB_URL="https://hub.<domain>" \
BIONIC_ADMIN_TOKEN="<bht_... token>" \
node hub/dist/cli/bionic-ctl.js apply --dir <your-config-dir>
```

### Step 6: Smoke-Test End-to-End Flow
1. Create a new project in `https://hub.<domain>` using your synced `bio-standard` template.
2. Confirm the GCE VM boots with **no external IP**, attests via `/api/internal/vm/attest`, transitions to `running`, and opens cleanly at `https://<prj-id>.editors.<domain>`.
3. Confirm Live Web Report renders on its isolated origin `https://<prj-id>.reports.<domain>` and that clicking **Publish** executes `scripts/publish.sh` and publishes to `static-reports-private` / `static-reports-public`.
4. Confirm freezing (manual or after 20m inactivity) suspends the VM and revisiting the Editor URL triggers Auto-Wake and resumes cleanly.

---

## 4. Hosting the Public Interactive Example Project (Optional)

`examples/demo-rnaseq-project/` is a self-contained reproducible bioinformatics module (`SPEC.md`, `code/analyze.py`, `tests/scientific/test_panel_1.py`, `data/manifest.json`, interactive `web-report/index.html`, and portable `scripts/*.sh`).

To host it safely for anonymous website visitors (read-only workspace, zero shell/Python/OpenCode execution, zero outbound internet egress):
```bash
npm run build
docker build -f examples/demo-rnaseq-project/Dockerfile.sandbox -t bionic-public-demo .
docker network create --internal bionic-sandbox-net
docker run -d --name bionic-public-demo \
  --network bionic-sandbox-net \
  --read-only --tmpfs /tmp:rw,nosuid,size=128m \
  --memory 256m --cpus 0.5 \
  bionic-public-demo
```
Proxy HTTP traffic from your website's reverse proxy (attached to `bionic-sandbox-net`) to `bionic-public-demo:3000` with rate limiting.

---

## 5. Standalone / Exported Project Workflow (Zero Lock-In)

Any coder can clone or download any completed Bionic project outside of GCP/Bionic Hub and run the exact same bash scripts locally or in CI:
```bash
./scripts/data-pull.sh                                # Hydrate & SHA-256 verify raw data
./scripts/run.sh                                      # Run pipeline + scientific tests + build report
./scripts/verify-data.sh                              # Pre-publish provenance & leak check
PUBLISH_TARGET=gs://my-site/demo ./scripts/publish.sh # Publish web-report/ to GCS/S3/rsync/local
```
