# Bionic Hub — Cloud Infrastructure Requirements Specification

This document specifies the **minimum necessary cloud infrastructure components** required to deploy **Bionic Hub** on any cloud provider (GCP, AWS, Azure, or private cloud). Hand this file directly to an infrastructure engineer or LLM to generate Terraform tailored to your cloud provider and existing VPC/networking conventions.

---

## 1. System Architecture & Traffic Matrix

Bionic Hub is a server-side control plane + reverse proxy that provisions isolated per-project **Editor VMs** and ephemeral **Reproducible Runner VMs**. Because Editor and Runner VMs execute arbitrary AI-generated code, they are treated as **untrusted compute**.

```text
Internet / Corporate Users
        │ HTTPS (443, TLS 1.3 + Wildcard Certs)
        ▼
Edge Reverse Proxy / HTTPS Load Balancer
  • hub.<domain>                 → Hub :4000 (Control Plane + UI)
  • *.editors.<domain>           → Hub :4000 (mTLS Editor Proxy)
  • *.reports.<domain>           → Hub :4000 (Isolated Live/Private Report Proxy)
  • public-reports.<domain>      → Hub :4000 (Demo auth) OR Static Site Bucket (Enterprise)
        │
        ▼
Bionic Hub Server (127.0.0.1:4000, Private VPC)
  ├── PostgreSQL 16 (Private IP, TLS)
  ├── Object Storage (4 Isolated Buckets)
  ├── Secrets Manager (OIDC, LLM/Bedrock, MCP, CA/JWT Keys)
  ├── Editor Subnet (NO Public IPs, NAT Egress Only) ── Hub→VM mTLS :3000 & :3002; VM→Hub :443
  └── Runner Subnet (NO Public IPs, ZERO Internet Egress) ── VM→Hub :443 ONLY
```

### Exact Port & Protocol Matrix

| Source | Destination | Port / Proto | Purpose |
|---|---|---|---|
| Users / CI | Edge Proxy / Load Balancer | TCP `443` (and `80` → `443`) | HTTPS UI, API, WebSockets (`/ws`), SSE |
| Edge Proxy / LB | Bionic Hub Server | TCP `4000` (loopback or private) | HTTP/WS/SSE proxy to Hub (`HUB_HOST=127.0.0.1` when colocated) |
| Bionic Hub Server | Editor VMs (`bionic-editor-vm`) | TCP `3000`, `3002` | **mTLS only**: `:3000` Editor & Live Report; `:3002` `/api/internal/*` |
| Editor & Runner VMs | Bionic Hub Server | TCP `443` (via Edge Proxy) | VM attestation, LLM/MCP/Git/Data gateways |
| Bionic Hub Server | PostgreSQL 16 | TCP `5432` (TLS) | Control plane state, sessions, config revisions, job queue |
| Editor VMs | Internet (via NAT) | Outbound TCP `443`/`80` | Package installs, public scientific data downloads |
| Runner VMs | Internet | **DENY ALL** | Strictly isolated; reaches Hub `:443` only |
| Editor / Runner VMs | Other Editor / Runner VMs | **DENY ALL** | Zero east-west lateral movement |

---

## 2. Required Infrastructure Components (Minimum Necessary Set)

Generate Terraform for the following **8 components** using your target cloud provider's native resources.

### 2.1 VPC, Subnets & NAT
1. **Hub Subnet** — Hosts the Bionic Hub server/pods and Edge Reverse Proxy / Load Balancer.
2. **Editor VM Subnet** (e.g., `/20`) — Hosts per-project Editor VMs.
   - **No public IPs** attached to VMs.
   - Outbound internet routed strictly through a **NAT Gateway / Cloud NAT**.
   - Private access to cloud object storage enabled (e.g., GCP Private Google Access / AWS S3 Gateway Endpoint / Azure Service Endpoint).
3. **Runner VM Subnet** (e.g., `/20`) — Hosts ephemeral headless reproduction VMs.
   - **No public IPs** and **NO NAT Gateway** (zero internet egress).

### 2.2 Firewalls / Security Groups
Enforce these rules using security groups or network tags (`bionic-hub-server`, `bionic-editor-vm`, `bionic-runner-noegress`):
- **Hub Ingress:** Allow TCP `80`/`443` from allowed user/CI CIDR ranges (or Load Balancer). Allow TCP `443` from Editor and Runner subnet CIDRs. Never expose port `4000` to VPC subnets or the internet.
- **Editor VM Ingress:** Allow TCP `3000` and `3002` **only** from Hub (`bionic-hub-server`). **Deny all** ingress from Editor and Runner subnets (zero east-west traffic).
- **Runner VM Egress:** Allow TCP `443` **only** to the Hub subnet/proxy internal IP. **Deny all** other egress (`0.0.0.0/0`).

### 2.3 DNS & Wildcard TLS
1. **Private Split-Horizon DNS Zone** (attached to the VPC):
   - Resolve **`hub.<domain>`** → Hub reverse proxy's **internal VPC IP**.
   - *Required so Zero-NAT Runner VMs can reach `https://hub.<domain>` and Editor VMs do not hairpin traffic through paid NAT.*
2. **Public DNS & Wildcard TLS Certificates** (pointing to Edge Proxy / Load Balancer):
   - `hub.<domain>` → Hub (`:4000`)
   - `*.editors.<domain>` → Hub (`:4000`) — per-project isolated Editor origins (`<prj-id>.editors.<domain>`)
   - `*.reports.<domain>` → Hub (`:4000`) — isolated live report previews & private/org publications
   - `public-reports.<domain>`:
     - **Demo mode (`HUB_PUBLIC_REPORTS_REQUIRE_AUTH=true`):** Proxy **all** requests to Hub (`:4000`) so the publication bucket stays completely private behind Hub login.
     - **Enterprise mode (`HUB_PUBLIC_REPORTS_REQUIRE_AUTH=false`):** Client secures the static site (CDN/WAF/IAP/VPN); route `/reports/*/latest*` → Hub (`/_public/reports/:slug/latest*` for stateless `302` redirects) and serve `/reports/*/v*/*` directly from the static site bucket.
3. **Reverse Proxy Requirements:** Must support **wildcard TLS** (DNS-01 ACME or managed wildcard certs), **WebSocket upgrades**, and **long-lived SSE streams** (disable short 60s idle timeouts).

### 2.4 Bionic Hub Compute Host
- Run the container built from `hub/Dockerfile` (exposes port `4000`, healthcheck `GET /healthz`, automatically executes idempotent DB migrations on startup).
- **Runtime Requirement:** Must be a persistent compute host — VM (min 2 vCPU / 4 GB RAM for dev/demo), Managed Instance Group / ASG, or Kubernetes (GKE/EKS/AKS). **Do NOT use request-scoped serverless runtimes with 60-minute caps** (e.g., Cloud Run / Lambda) because Hub maintains long-lived WebSocket terminals, SSE streams, and background reconciler/idle-reaper loops.
- **Persistent Storage (if single-node or local Git):** Mount a persistent volume (e.g., 50 GB) for stable CA/JWT certs (`/srv/bionic-hub/certs`), Git repos (`HUB_GIT_LOCAL_DIR`, if not using external Forgejo/GitHub), and local scratch (`HUB_LOCAL_STORAGE_DIR`).

### 2.5 PostgreSQL 16 Database
- Managed PostgreSQL 16 (Cloud SQL / RDS / Flexible Server) on a **private IP** with **TLS required**, or a local Postgres 16 container on persistent storage with nightly backups to object storage for low-cost testing.
- Connection budget per Hub replica: `DB_API_POOL_MAX` (default `8`) + `DB_WORKER_POOL_MAX` (default `4`) + `1` dedicated `LISTEN/NOTIFY` connection (~14 connections total).

### 2.6 Object Storage (4 Strictly Separated Buckets)
All buckets must enforce uniform bucket-level access (no per-object ACLs):

| Bucket | Env Var | Public Access | Required Settings |
|---|---|---|---|
| **Project Raw Data** | `GCP_PROJECT_DATA_BUCKET` | **Private** (public access blocked) | **Object Versioning enabled**; CORS allowing `PUT, POST, GET, HEAD, OPTIONS` from `https://hub.<domain>` with headers `Content-Type, Content-Range, Range, Location, x-goog-resumable` |
| **Shared Datasets** | `GCP_SHARED_DATA_BUCKET` | **Private** (public access blocked) | Read-only institutional datasets mounted via FUSE on Editor VMs |
| **Private/Org Reports** | `GCP_STATIC_PRIVATE_BUCKET` | **Private** (public access blocked) | Served strictly via Hub on `<pub-id>.reports.<domain>` |
| **Published Reports Site** | `GCP_STATIC_PUBLIC_BUCKET` | **Demo:** Private (blocked, proxied via Hub)<br>**Enterprise:** Client-managed static site security | Stores `visibility = "public"` static report builds |

### 2.7 IAM Roles / Service Accounts (Strict Least Privilege)
Provision **3 distinct identities** (never use default project/compute service accounts):

| Identity | Attached To | Minimum Required Permissions |
|---|---|---|
| **Hub Control Plane** | Hub host / pods | • VM/Disk/Snapshot lifecycle management (create, suspend/stop, resume/start, delete, list)<br>• Read access to Secrets Manager secrets<br>• Read/Write object admin on the 4 Bionic buckets<br>• **`ActAs` / `PassRole` granted STRICTLY per-resource** on each allowlisted Template identity and the Runner Zero-IAM identity (**NEVER project/account-wide!**)<br>• DNS record admin *(only if using DNS-01 ACME via cloud DNS)* |
| **Template Identity** *(1 per template class, e.g. `bionic-tmpl-bio-standard`)* | Editor VMs | • Read-only access to the Shared Datasets bucket (`GCP_SHARED_DATA_BUCKET`)<br>• Any domain-specific read roles explicitly approved for that template class<br>• **Zero** compute, IAM, or `project-data` bucket-wide permissions |
| **Runner Zero-IAM Identity** (`bionic-runner-noiam`) | Fallback headless Runner VMs | • **Zero** cloud permissions |

#### Cloud Provider Mapping Reference

| Requirement | GCP | AWS | Azure |
|---|---|---|---|
| Compute VMs & Images | GCE Instances + Machine Images (`infra/packer/`) | EC2 Instances + AMIs | Virtual Machines + Compute Gallery Images |
| Outbound Editor NAT | Cloud Router + Cloud NAT | NAT Gateway | NAT Gateway |
| Private Split-Horizon DNS | Cloud DNS Private Zone | Route 53 Private Hosted Zone | Azure Private DNS Zone |
| Object Storage | Cloud Storage (GCS) | Amazon S3 | Azure Blob Storage |
| Database | Cloud SQL PostgreSQL 16 (Private Service Access) | RDS PostgreSQL 16 | Azure Database for PostgreSQL Flexible Server |
| Secrets | Secret Manager | AWS Secrets Manager | Azure Key Vault |
| VM Identity Attestation | GCE Instance Identity JWT (`format=full`) | EC2 Instance Identity Document (PKCS7) | Azure IMDS Attested Document |
| Per-SA Assumption Guard | `roles/iam.serviceAccountUser` on target SA | `iam:PassRole` restricted to target Role ARN | Managed Identity Operator on target UAMI |

### 2.8 Secrets & Persistent Cryptographic Keys
Provision secrets in your cloud Secrets Manager (values populated out-of-band, never in Terraform state):
1. **Persistent Internal mTLS CA + Ed25519 Workload JWT Keys (CRITICAL):** Generate once and mount/inject into all Hub replicas so restarts and horizontal scaling never break mTLS/JWT auth to running VMs:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out ca.key
   openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=Bionic Hub Internal CA" -out ca.crt
   openssl genpkey -algorithm ED25519 -out jwt-ed25519.key
   openssl pkey -in jwt-ed25519.key -pubout -out jwt-ed25519.pub
   ```
2. **Auth Secrets:** OIDC client secret (`OIDC_CLIENT_SECRET_REF`) for enterprise SSO, OR `BIONIC_BOOTSTRAP_ADMIN_PASSWORD` for demo local auth.
3. **Model & MCP Secrets:** Provider API keys (Gemini/OpenAI/Anthropic) or AWS Bedrock credentials (or zero-key OIDC Web Identity Federation trusting the Hub Control Plane identity) referenced via `gcp-sm://...` / `aws-sm://...` inside admin YAML configs.

---

## 3. Required Hub Runtime Environment Contract

The Hub server (`hub/server/config.ts`) reads the following required environment variables:

```env
NODE_ENV=production
HUB_ID=bionic-hub-prod
HUB_HOST=127.0.0.1
HUB_PORT=4000
HUB_DOMAIN=bionic.example.com

DATABASE_URL=postgres://bionic:<password>@<db-private-ip>:5432/bionic_hub?sslmode=require
DB_SSL_MODE=require

HUB_COMPUTE_PROVIDER=gcp                  # Currently implemented: gcp | local
GCP_PROJECT_ID=<project-id>
GCP_DEFAULT_ZONE=<zone>
GCP_EDITOR_SUBNET=<editor-subnet-name>
GCP_RUNNER_SUBNET=<runner-subnet-name>
GCP_PROJECT_DATA_BUCKET=<project-data-bucket>
GCP_SHARED_DATA_BUCKET=<shared-datasets-bucket>
GCP_STATIC_PUBLIC_BUCKET=<static-public-bucket>
GCP_STATIC_PRIVATE_BUCKET=<static-private-bucket>
HUB_ALLOWLISTED_SAS=<comma-separated-template-sa-emails>
GCP_RUNNER_NOIAM_SA=<runner-noiam-sa-email>
HUB_BLOCKED_CIDRS=<vpc-cidr>              # Blocks SSRF into VPC/DB/Editor subnets

# Persistent mTLS CA & Ed25519 Workload JWT keys (PEM env vars OR file paths)
HUB_INTERNAL_CA_CERT_FILE=/srv/bionic-hub/certs/ca.crt
HUB_INTERNAL_CA_KEY_FILE=/srv/bionic-hub/certs/ca.key
HUB_JWT_PRIVATE_KEY_FILE=/srv/bionic-hub/certs/jwt-ed25519.key
HUB_JWT_PUBLIC_KEY_FILE=/srv/bionic-hub/certs/jwt-ed25519.pub

# Git storage ('forgejo' w/ HUB_GIT_UPSTREAM_URL + HUB_GIT_SERVICE_TOKEN, OR 'local' on persistent disk)
HUB_GIT_PROVIDER=local
HUB_GIT_LOCAL_DIR=/srv/bionic-hub/git
HUB_LOCAL_STORAGE_DIR=/srv/bionic-hub/storage

# Auth — Enterprise (OIDC SSO)
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<oidc-client-id>
OIDC_CLIENT_SECRET_REF=gcp-sm://projects/<project-id>/secrets/bionic-oidc-client-secret/versions/latest
BIONIC_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
HUB_LOCAL_AUTH_ENABLED=false
HUB_PUBLIC_REPORTS_REQUIRE_AUTH=false

# Auth — Demo Overrides (use instead of OIDC for manually-invited demo users & private publication site)
# HUB_LOCAL_AUTH_ENABLED=true
# HUB_PUBLIC_REPORTS_REQUIRE_AUTH=true
# BIONIC_BOOTSTRAP_ADMIN_PASSWORD=<min-12-char-admin-password>
```

---

## 4. Golden Editor VM Image Requirements (`infra/packer/`)

Editor and Runner VMs must boot from a pre-baked Linux image (reference Packer build in `infra/packer/bionic-bio-standard.pkr.hcl` + `infra/packer/scripts/provision.sh`) containing:
1. **OS & Tooling:** Ubuntu 24.04 LTS, Node.js 22, Python 3.12, `uv`, `git`, `chrony`, `nftables`, `openssl`, `jq`, `gcsfuse` (or cloud FUSE client), pinned OpenCode V2, built `bioniceditor` (`/opt/bioniceditor`), and built `bionic-daemon` (`/opt/bionic-hub`).
2. **Two Unprivileged OS Accounts (Zero `root` / Zero `CAP_SETUID`):**
   - `bionic-daemon`: Runs `bionic-daemon.service` (mTLS `:3000`/`:3002`, localhost shim `127.0.0.1:3001`, `/run/bionic-daemon` `0700`).
   - `bionic-user`: Runs `bioniceditor.service` (bound strictly to `/run/bionic-editor/app.sock` + `127.0.0.1:3003`), `opencode serve`, `.venv`, terminal, and `git`.
3. **IMDS Isolation (`nftables`):** Drop outbound TCP `169.254.169.254:80` for all UIDs except `root` and `bionic-daemon` so untrusted workspace code cannot steal VM identity tokens.
4. **Boot Bootstrap (`bionic-vm-bootstrap.service`):** Oneshot root service running before daemon/editor that mounts the attached persistent workspace disk at `/var/lib/bionic/workspace`, reads instance metadata (`bionic-hub-origin`, `bionic-project-id`, `bionic-shared-data-bucket`), generates per-boot random `BIONIC_LOCAL_SHIM_TOKEN` and `BIONIC_DAEMON_TOKEN`, and writes `0600` `/etc/bionic-daemon.env` and `/etc/bionic-editor.env`.

---

## 5. Software Installation & Verification Steps

1. **Build & Push Hub Image:**
   ```bash
   docker build -f hub/Dockerfile -t <registry>/<repo>/bionic-hub:latest .
   docker push <registry>/<repo>/bionic-hub:latest
   ```
2. **Build Golden Editor VM Image (inside Editor subnet w/ NAT + IAP/bastion SSH):**
   ```bash
   npm ci && npm --prefix client ci && npm run build && npm pack && mv bioniceditor-*.tgz bioniceditor.tgz
   npm --prefix packages/shared ci && npm --prefix packages/shared run build
   npm --prefix hub ci && npm --prefix hub run build
   tar -czf bionic-hub-daemon.tgz -C hub package.json package-lock.json dist
   (cd infra/packer && packer init bionic-bio-standard.pkr.hcl && packer build \
     -var "project_id=<project>" -var "zone=<zone>" \
     -var "network=<vpc>" -var "subnetwork=<editor-subnet>" \
     bionic-bio-standard.pkr.hcl)
   ```
3. **Start Hub & Verify Health:**
   Deploy the Hub container with Section 3 env vars behind your reverse proxy, then verify:
   ```bash
   curl -fsS https://hub.<domain>/healthz
   ```
4. **Bootstrap Admin & Sync GitOps Config (`templates/`, `models/`, `skills/`, `mcp/`):**
   Sign in at `https://hub.<domain>`, mint a scoped CI Admin PAT via `POST /api/v1/admin/tokens` (or configure `ci_oidc_trust_policies`), and apply your version-controlled YAML configs (examples in `infra/config-examples/`):
   ```bash
   BIONIC_HUB_URL="https://hub.<domain>" BIONIC_ADMIN_TOKEN="<bht_...>" \
     node hub/dist/cli/bionic-ctl.js apply --dir <your-config-dir>
   ```
   *(In Demo mode, open **Admin → Demo Users** to manually invite users and generate their one-time password setup links.)*
