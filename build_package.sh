#!/usr/bin/env bash
# Package Bionic Editor + Bionic Daemon tarballs and bake the Golden Editor VM image via Packer.
# Configure via environment variables or a local (gitignored) `.env.deploy` file.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.deploy"
  set +a
fi

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID (in environment or .env.deploy)}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
VPC_NETWORK="${VPC_NETWORK:-bionic-hub-vpc}"
EDITOR_SUBNET="${EDITOR_SUBNET:-bionic-editors-subnet}"
OPENCODE_VERSION="${OPENCODE_VERSION:-latest}"

# 1. Package Bionic Editor and Bionic Daemon tarballs
rm -f bioniceditor-*.tgz bioniceditor.tgz bionic-hub-daemon.tgz
npm ci && npm --prefix client ci && npm run build && npm pack
mv bioniceditor-*.tgz bioniceditor.tgz

npm --prefix packages/shared ci && npm --prefix packages/shared run build
npm --prefix hub ci && npm --prefix hub run build
tar -czf bionic-hub-daemon.tgz -C hub package.json package-lock.json dist

# 2. Build the GCE image into your GCP project
cd infra/packer
packer init bionic-bio-standard.pkr.hcl
packer build \
  -var "project_id=${GCP_PROJECT_ID}" \
  -var "zone=${GCP_ZONE}" \
  -var "network=${VPC_NETWORK}" \
  -var "subnetwork=${EDITOR_SUBNET}" \
  -var "opencode_version=${OPENCODE_VERSION}" \
  bionic-bio-standard.pkr.hcl
