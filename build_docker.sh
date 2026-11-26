#!/usr/bin/env bash
# Build and push the Bionic Hub Docker image to GCP Artifact Registry.
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
GCP_REGION="${GCP_REGION:-us-central1}"
ARTIFACT_REPO="${ARTIFACT_REPO:-bionic-hub}"
IMAGE_NAME="${IMAGE_NAME:-bionic-hub}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DOCKER_CMD="${DOCKER_CMD:-docker}"

REGISTRY="${GCP_REGION}-docker.pkg.dev"
IMAGE_URI="${REGISTRY}/${GCP_PROJECT_ID}/${ARTIFACT_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "Building ${IMAGE_URI}..."
${DOCKER_CMD} build -f hub/Dockerfile -t "${IMAGE_URI}" .

echo "Authenticating to ${REGISTRY}..."
gcloud auth print-access-token | ${DOCKER_CMD} login -u oauth2accesstoken --password-stdin "https://${REGISTRY}"

echo "Pushing ${IMAGE_URI}..."
${DOCKER_CMD} push "${IMAGE_URI}"
echo "OK: Pushed ${IMAGE_URI}"
