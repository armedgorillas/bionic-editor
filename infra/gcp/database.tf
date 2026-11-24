# Optional Cloud SQL PostgreSQL 16 (mandatory in enterprise, opt-in in dev)

resource "random_password" "db_password" {
  count   = var.db_mode == "cloud_sql" ? 1 : 0
  length  = 32
  special = false
}

resource "google_sql_database_instance" "bionic" {
  count               = var.db_mode == "cloud_sql" ? 1 : 0
  name                = "bionic-hub-pg-${random_id.bucket_suffix.hex}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.profile == "enterprise"

  depends_on = [google_service_networking_connection.private_vpc_connection]

  settings {
    tier              = var.profile == "enterprise" ? "db-custom-4-16384" : "db-f1-micro"
    availability_type = var.profile == "enterprise" ? "REGIONAL" : "ZONAL"

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.profile == "enterprise"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.bionic.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }
}

resource "google_sql_database" "hub" {
  count    = var.db_mode == "cloud_sql" ? 1 : 0
  name     = "bionic_hub"
  instance = google_sql_database_instance.bionic[0].name
}

resource "google_sql_user" "hub" {
  count    = var.db_mode == "cloud_sql" ? 1 : 0
  name     = "bionic"
  instance = google_sql_database_instance.bionic[0].name
  password = random_password.db_password[0].result
}

resource "google_secret_manager_secret_version" "cloud_sql_password" {
  count       = var.db_mode == "cloud_sql" ? 1 : 0
  secret      = google_secret_manager_secret.hub_secrets["bionic-db-password"].id
  secret_data = random_password.db_password[0].result
}
