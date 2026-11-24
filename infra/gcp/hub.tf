# Bionic Hub Control Plane Host + Static External IP (dev profile: e2-medium + DNS-01 Caddy)

resource "google_compute_address" "hub_static_ip" {
  name   = "bionic-hub-static-ip"
  region = var.region
}

resource "google_compute_disk" "hub_data" {
  name = "bionic-hub-data-pd"
  type = "pd-balanced"
  zone = var.zone
  size = 50
}

resource "google_compute_instance" "hub" {
  name         = "bionic-hub-server"
  machine_type = var.hub_machine_type
  zone         = var.zone
  tags         = ["bionic-hub-server"]

  boot_disk {
    initialize_params {
      image = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
      size  = 30
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.hub_data.id
    device_name = "bionic-hub-data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.hub.id
    access_config {
      nat_ip = google_compute_address.hub_static_ip.address
    }
  }

  service_account {
    email  = google_service_account.hub.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  metadata = {
    block-project-ssh-keys = "true"
    startup-script         = <<-EOT
      #!/usr/bin/env bash
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq && apt-get install -y -qq docker.io docker-compose-v2 ca-certificates curl openssl jq

      # 1. Format (if new) and mount the 50 GB persistent data disk at /srv/bionic-hub
      DATA_DEV="/dev/disk/by-id/google-bionic-hub-data"
      mkdir -p /srv/bionic-hub
      if [[ -b "$DATA_DEV" ]]; then
        if ! blkid "$DATA_DEV" >/dev/null 2>&1; then
          mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DATA_DEV"
        fi
        grep -q "$DATA_DEV" /etc/fstab || echo "$DATA_DEV /srv/bionic-hub ext4 discard,defaults,nofail 0 2" >> /etc/fstab
        mountpoint -q /srv/bionic-hub || mount "$DATA_DEV" /srv/bionic-hub
      fi

      mkdir -p /srv/bionic-hub/{pgdata,git,storage,certs,caddy-data,caddy-config}
      chmod 700 /srv/bionic-hub/certs

      # 2. Persist stable Internal CA & Ed25519 JWT signing keys across Hub restarts
      if [[ ! -f /srv/bionic-hub/certs/ca.key ]]; then
        openssl ecparam -name prime256v1 -genkey -noout -out /srv/bionic-hub/certs/ca.key
        openssl req -x509 -new -nodes -key /srv/bionic-hub/certs/ca.key -sha256 -days 3650 \
          -subj "/CN=Bionic Hub Internal CA/O=Bionic Hub" -out /srv/bionic-hub/certs/ca.crt
        chmod 600 /srv/bionic-hub/certs/ca.key
      fi
      if [[ ! -f /srv/bionic-hub/certs/jwt-ed25519.key ]]; then
        openssl genpkey -algorithm ED25519 -out /srv/bionic-hub/certs/jwt-ed25519.key
        openssl pkey -in /srv/bionic-hub/certs/jwt-ed25519.key -pubout -out /srv/bionic-hub/certs/jwt-ed25519.pub
        chmod 600 /srv/bionic-hub/certs/jwt-ed25519.key
      fi

      # 3. Generate local Postgres password if db_mode == local_docker
      if [[ ! -f /srv/bionic-hub/certs/local-pg.pass ]]; then
        openssl rand -hex 24 > /srv/bionic-hub/certs/local-pg.pass
        chmod 600 /srv/bionic-hub/certs/local-pg.pass
      fi
      LOCAL_PG_PASSWORD="$(cat /srv/bionic-hub/certs/local-pg.pass)"

      DB_URL="postgres://bionic:$${LOCAL_PG_PASSWORD}@127.0.0.1:5432/bionic_hub"
      %{if var.db_mode == "cloud_sql"}
      CLOUD_SQL_PW="$(gcloud secrets versions access latest --secret=bionic-db-password 2>/dev/null || true)"
      DB_URL="postgres://bionic:$${CLOUD_SQL_PW}@${google_sql_database_instance.bionic[0].private_ip_address}:5432/bionic_hub?sslmode=require"
      %{endif}

      cat > /srv/bionic-hub/hub.env <<EOF
      NODE_ENV=production
      HUB_ID=bionic-hub-${var.project_id}
      HUB_HOST=127.0.0.1
      HUB_PORT=4000
      HUB_DOMAIN=${var.domain}
      ACME_EMAIL=${var.bootstrap_admin_email}
      LOCAL_PG_PASSWORD=$${LOCAL_PG_PASSWORD}
      DATABASE_URL=$${DB_URL}
      DB_SSL_MODE=${var.db_mode == "cloud_sql" ? "require" : "disable"}
      HUB_COMPUTE_PROVIDER=gcp
      GCP_PROJECT_ID=${var.project_id}
      GCP_DEFAULT_ZONE=${var.zone}
      GCP_EDITOR_SUBNET=${google_compute_subnetwork.editors.name}
      GCP_RUNNER_SUBNET=${google_compute_subnetwork.runners_noegress.name}
      GCP_PROJECT_DATA_BUCKET=${google_storage_bucket.project_data.name}
      GCP_SHARED_DATA_BUCKET=${google_storage_bucket.shared_datasets.name}
      GCP_STATIC_PUBLIC_BUCKET=${google_storage_bucket.static_reports_public.name}
      GCP_STATIC_PRIVATE_BUCKET=${google_storage_bucket.static_reports_private.name}
      HUB_ALLOWLISTED_SAS=${google_service_account.tmpl_bio_standard.email}
      GCP_RUNNER_NOIAM_SA=${google_service_account.runner_noiam.email}
      HUB_BLOCKED_CIDRS=10.42.0.0/16
      HUB_GIT_LOCAL_DIR=/srv/bionic-hub/git
      HUB_LOCAL_STORAGE_DIR=/srv/bionic-hub/storage
      HUB_INTERNAL_CA_CERT_FILE=/srv/bionic-hub/certs/ca.crt
      HUB_INTERNAL_CA_KEY_FILE=/srv/bionic-hub/certs/ca.key
      HUB_JWT_PRIVATE_KEY_FILE=/srv/bionic-hub/certs/jwt-ed25519.key
      HUB_JWT_PUBLIC_KEY_FILE=/srv/bionic-hub/certs/jwt-ed25519.pub
      BIONIC_BOOTSTRAP_ADMIN_EMAIL=${var.bootstrap_admin_email}
      OIDC_ISSUER=${var.oidc_issuer}
      OIDC_CLIENT_ID=${var.oidc_client_id}
      OIDC_CLIENT_SECRET_REF=gcp-sm://projects/${var.project_id}/secrets/bionic-oidc-client-secret/versions/latest
      EOF
      chmod 600 /srv/bionic-hub/hub.env

      # 4. Nightly pg_dump backup to GCS when db_mode == local_docker
      %{if var.db_mode == "local_docker"}
      cat > /etc/cron.daily/bionic-pg-backup <<'CRONEOF'
      #!/usr/bin/env bash
      set -euo pipefail
      TS="$(date -u +%Y%m%dT%H%M%SZ)"
      docker exec bionic-hub-postgres-1 pg_dump -U bionic bionic_hub | gzip | gcloud storage cp - "gs://${google_storage_bucket.project_data.name}/_hub-backups/bionic_hub_$${TS}.sql.gz"
      CRONEOF
      chmod 755 /etc/cron.daily/bionic-pg-backup
      %{endif}
    EOT
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
}
