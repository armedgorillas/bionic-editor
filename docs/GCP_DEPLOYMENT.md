# Deploying Bionic Hub on GCP & Hosting the Public Demo

This guide walks through deploying **Bionic Hub** on your own Google Cloud Platform (GCP) project using `infra/gcp/` Terraform, building your first Packer Golden VM Image, syncing templates/models (including AWS Bedrock)/skills/MCP via GitOps, and hosting the locked-down public example project on your website.

---

## 1. Prerequisites

- A GCP Project with billing enabled (`gcloud auth application-default login`)
- Enable required GCP APIs:
  ```bash
  gcloud services enable compute.googleapis.com iam.googleapis.com \
    cloudresourcemanager.googleapis.com servicenetworking.googleapis.com \
    secretmanager.googleapis.com storage.googleapis.com dns.googleapis.com \
    sqladmin.googleapis.com
  ```
- A domain you control (e.g., `bionic.yourdomain.com`) in Cloud DNS or Cloudflare (for DNS-01 wildcard TLS certificates covering `*.editors.<domain>` and `*.reports.<domain>`).
- A Google Cloud OAuth 2.0 Web Client (for 2-minute zero-cost OIDC SSO):
  - Authorized redirect URI: `https://hub.<domain>/api/v1/auth/oidc/callback`

---

## 2. Provision Platform Infrastructure (`infra/gcp/`)

`profile = "dev"` with `db_mode = "local_docker"` deploys in ~2 minutes and idles at **~$35–$55/month** (using a single `e2-medium` Hub host + pre-built DNS-01 Caddy + 4 isolated GCS buckets + Editor VPC w/ Cloud NAT + Zero-NAT No-Egress Runner subnet).

```bash
cd infra/gcp
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your project_id, domain, bootstrap_admin_email, oidc_client_id

terraform init
terraform plan
terraform apply
```

### Point Your DNS Records
Using the `hub_static_ip` output from Terraform, create 4 `A` records:
- `hub.<domain>` → `<hub_static_ip>`
- `*.editors.<domain>` → `<hub_static_ip>`
- `*.reports.<domain>` → `<hub_static_ip>`
- `public-reports.<domain>` → `<hub_static_ip>`

### Populate Secret Manager
```bash
printf '%s' "$OIDC_CLIENT_SECRET" | gcloud secrets versions add bionic-oidc-client-secret --data-file=-
printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add bionic-gemini-api-key --data-file=-
# Optional: AWS Bedrock credentials (or use zero-key GCP-to-AWS OIDC Web Identity Federation)
```

---

## 3. Build Your First Golden VM Image (`infra/packer/`)

```bash
cd infra/packer
packer init bionic-bio-standard.pkr.hcl
packer build -var "project_id=YOUR_GCP_PROJECT_ID" bionic-bio-standard.pkr.hcl
```

This creates the immutable `bionic-bio-standard` GCE image family with Ubuntu 24.04, Node 22, Python 3.12, `uv`, `gcsfuse`, `chrony`, `nftables`, two-unit systemd (`bionic-daemon.service` + `bioniceditor.service`), and locked-down `sudoers`.

---

## 4. Sync Templates, Models (incl. AWS Bedrock), Skills & MCP via GitOps

Update the GCP project ID in `infra/config-examples/` and run:

```bash
npm --prefix packages/shared run build
npm --prefix hub run build

# Dry-run diff first
BIONIC_HUB_URL="https://hub.<domain>" \
BIONIC_ADMIN_TOKEN="<your-admin-pat-or-ci-oidc-jwt>" \
node hub/dist/cli/bionic-ctl.js apply --dir infra/config-examples --dry-run

# Apply live
BIONIC_HUB_URL="https://hub.<domain>" \
BIONIC_ADMIN_TOKEN="<your-admin-pat-or-ci-oidc-jwt>" \
node hub/dist/cli/bionic-ctl.js apply --dir infra/config-examples
```

---

## 5. Hosting the Interactive Public Demo on Your Website

`examples/demo-rnaseq-project/` is a complete, zero-dependency, self-contained bioinformatics analysis module (`SPEC.md`, `code/analyze.py`, `data/manifest.json`, passing `tests/scientific/test_panel_1.py`, interactive `web-report/index.html`, and portable `scripts/{run.sh,publish.sh,data-pull.sh,data-push.sh,verify-data.sh}`).

Run it safely for anonymous website visitors using `Dockerfile.sandbox` (`BIONIC_SANDBOX_MODE=true`, non-root user, **zero shell/Python/OpenCode execution**):

```bash
npm run build
docker build -f examples/demo-rnaseq-project/Dockerfile.sandbox -t bionic-public-demo .
# Zero outbound egress (--internal network) while remaining reachable by your reverse proxy (Caddy/Nginx)
docker network create --internal bionic-sandbox-net
docker run -d --name bionic-public-demo --network bionic-sandbox-net \
  --read-only --tmpfs /tmp:rw,nosuid,size=128m \
  --memory 256m --cpus 0.5 bionic-public-demo
```
*(In production, run under gVisor `--runtime=runsc` behind Caddy/Cloudflare with rate limiting.)*

---

## 6. Exporting Any Project for a Coder (Zero Vendor Lock-In)

Any coder can `git clone` or download a completed Bionic project onto their laptop or CI runner and run every workflow with plain bash:

```bash
./scripts/data-pull.sh                          # Hydrate & SHA-256 verify raw data
./scripts/run.sh                                # Run pipeline + scientific validation tests
./scripts/verify-data.sh                        # Pre-publish leak & provenance check
PUBLISH_TARGET=gs://my-site/demo ./scripts/publish.sh   # Publish web-report/ anywhere
```
