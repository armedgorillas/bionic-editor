# 4 Strictly Isolated GCS Buckets (Security C3: public vs private reports separated!)

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

locals {
  bprefix = "bionic-${var.project_id}-${random_id.bucket_suffix.hex}"
}

# 1. Project Raw Data Bucket (Private, Object Versioning enabled, CORS for direct browser resumable uploads)
resource "google_storage_bucket" "project_data" {
  name                        = "${local.bprefix}-project-data"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  cors {
    origin          = ["https://hub.${var.domain}"]
    method          = ["PUT", "POST", "GET", "HEAD", "OPTIONS"]
    response_header = ["Content-Type", "Content-Range", "Range", "Location", "x-goog-resumable"]
    max_age_seconds = 3600
  }
}

# 2. Shared Institutional Datasets Bucket (Read-Only gcsfuse mount on Editor VMs)
resource "google_storage_bucket" "shared_datasets" {
  name                        = "${local.bprefix}-shared-datasets"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
}

# 3. Private & Org Published Reports Bucket (ZERO public IAM!)
resource "google_storage_bucket" "static_reports_private" {
  name                        = "${local.bprefix}-reports-private"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
}

# 4. Public Published Reports Bucket (Exclusively for visibility='public' reports!)
resource "google_storage_bucket" "static_reports_public" {
  name                        = "${local.bprefix}-reports-public"
  location                    = var.region
  uniform_bucket_level_access = true

  website {
    main_page_suffix = "index.html"
    not_found_page   = "404.html"
  }
}

resource "google_storage_bucket_iam_member" "static_reports_public_read" {
  bucket = google_storage_bucket.static_reports_public.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Grant Hub Control Plane objectAdmin on all 4 buckets
resource "google_storage_bucket_iam_member" "hub_project_data_admin" {
  bucket = google_storage_bucket.project_data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_storage_bucket_iam_member" "hub_shared_data_admin" {
  bucket = google_storage_bucket.shared_datasets.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_storage_bucket_iam_member" "hub_private_reports_admin" {
  bucket = google_storage_bucket.static_reports_private.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_storage_bucket_iam_member" "hub_public_reports_admin" {
  bucket = google_storage_bucket.static_reports_public.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.hub.email}"
}
