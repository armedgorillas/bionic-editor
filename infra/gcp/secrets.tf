# GCP Secret Manager slots (populate versions securely via gcloud secrets versions add)

locals {
  secret_names = [
    "bionic-oidc-client-secret",
    "bionic-db-password",
    "bionic-internal-ca-cert",
    "bionic-internal-ca-key",
    "bionic-gemini-api-key",
    "bionic-openai-api-key",
    "bionic-anthropic-api-key",
    "bionic-aws-bedrock-access-key",
    "bionic-aws-bedrock-secret-key",
    "bionic-cloudflare-api-token"
  ]
}

resource "google_secret_manager_secret" "hub_secrets" {
  for_each  = toset(local.secret_names)
  secret_id = each.value

  replication {
    auto {}
  }
}
