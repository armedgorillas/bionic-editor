# Least-Privilege IAM Service Accounts (Security H2: per-SA actAs ONLY, never project-wide!)

resource "google_service_account" "hub" {
  account_id   = "bionic-hub-control-plane"
  display_name = "Bionic Hub Control Plane"
}

resource "google_service_account" "tmpl_bio_standard" {
  account_id   = "bionic-tmpl-bio-standard"
  display_name = "Bionic Template SA — Bio Standard"
}

resource "google_service_account" "runner_noiam" {
  account_id   = "bionic-runner-noiam"
  display_name = "Bionic Reproducible Runner (Zero-IAM)"
}

# Hub can manage GCE VMs & disks
resource "google_project_iam_member" "hub_compute_admin" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.hub.email}"
}

# Hub can read Secret Manager secrets (for LLM API keys, MCP tokens, CA key)
resource "google_project_iam_member" "hub_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.hub.email}"
}

# Hub can manage DNS-01 ACME TXT records if using Cloud DNS
resource "google_project_iam_member" "hub_dns_admin" {
  count   = var.dns_provider == "googleclouddns" ? 1 : 0
  project = var.project_id
  role    = "roles/dns.admin"
  member  = "serviceAccount:${google_service_account.hub.email}"
}

# CRITICAL Security H2: Grant `roles/iam.serviceAccountUser` STRICTLY per allowlisted template SA!
resource "google_service_account_iam_member" "hub_act_as_bio_standard" {
  service_account_id = google_service_account.tmpl_bio_standard.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_service_account_iam_member" "hub_act_as_runner_noiam" {
  service_account_id = google_service_account.runner_noiam.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.hub.email}"
}

# Template SA gets read-only access to shared institutional datasets only (project data uses Hub V4 signed URLs)
resource "google_storage_bucket_iam_member" "tmpl_shared_data_viewer" {
  bucket = google_storage_bucket.shared_datasets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.tmpl_bio_standard.email}"
}
