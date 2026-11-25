variable "project_id" {
  description = "GCP Project ID where Bionic Hub will be deployed"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for Hub and default Editor VMs"
  type        = string
  default     = "us-central1-a"
}

variable "domain" {
  description = "Base domain for Bionic Hub (e.g., bionic.example.com)"
  type        = string
}

variable "profile" {
  description = "Deployment profile: 'dev' (personal GCP test ~$35-55/mo) or 'enterprise'"
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "enterprise"], var.profile)
    error_message = "profile must be 'dev' or 'enterprise'"
  }
}

variable "db_mode" {
  description = "Database mode: 'local_docker' (fast, low-cost dev w/ nightly GCS pg_dump) or 'cloud_sql'"
  type        = string
  default     = "local_docker"
  validation {
    condition     = contains(["local_docker", "cloud_sql"], var.db_mode)
    error_message = "db_mode must be 'local_docker' or 'cloud_sql'"
  }
}

variable "bootstrap_admin_email" {
  description = "Verified email address granted initial Admin role on first OIDC login"
  type        = string
}

variable "oidc_issuer" {
  description = "OIDC Issuer URL (e.g. https://accounts.google.com)"
  type        = string
  default     = "https://accounts.google.com"
}

variable "oidc_client_id" {
  description = "OIDC Client ID"
  type        = string
  default     = ""
}

variable "hub_machine_type" {
  description = "GCE machine type for the Bionic Hub host in dev profile (min e2-medium / 4GB RAM)"
  type        = string
  default     = "e2-medium"
}

variable "dns_provider" {
  description = "DNS provider for Caddy DNS-01 wildcard ACME certificates ('googleclouddns' or 'cloudflare')"
  type        = string
  default     = "googleclouddns"
}

variable "local_auth_enabled" {
  description = "Demo-only: enable manual admin user invites with email/password setup (set false for enterprise OIDC)"
  type        = bool
  default     = true
}

variable "public_reports_require_auth" {
  description = "Demo-only: enforce authentication on the publication bucket (no allUsers IAM; proxied via Hub)"
  type        = bool
  default     = true
}
