# VPC, Editor Subnet (Cloud NAT), Zero-NAT Runner Subnet, and Zero-East-West Firewalls

resource "google_compute_network" "bionic" {
  name                    = "bionic-hub-vpc"
  auto_create_subnetworks = false
}

# Subnet 1: Bionic Hub Control Plane
resource "google_compute_subnetwork" "hub" {
  name                     = "bionic-hub-subnet"
  ip_cidr_range            = "10.42.0.0/24"
  region                   = var.region
  network                  = google_compute_network.bionic.id
  private_ip_google_access = true
}

# Subnet 2: Editor VMs (Zero Public IPs; outbound via Cloud NAT)
resource "google_compute_subnetwork" "editors" {
  name                     = "bionic-editors-subnet"
  ip_cidr_range            = "10.42.16.0/20"
  region                   = var.region
  network                  = google_compute_network.bionic.id
  private_ip_google_access = true
}

# Subnet 3: Reproducible Module Runners (ZERO Public IPs + ZERO Cloud NAT — Security C3!)
resource "google_compute_subnetwork" "runners_noegress" {
  name                     = "bionic-runners-noegress-subnet"
  ip_cidr_range            = "10.42.32.0/20"
  region                   = var.region
  network                  = google_compute_network.bionic.id
  private_ip_google_access = false
}

# Cloud Router & Cloud NAT — explicitly scoped ONLY to `editors` subnet (NEVER `runners_noegress`!)
resource "google_compute_router" "nat_router" {
  name    = "bionic-nat-router"
  region  = var.region
  network = google_compute_network.bionic.id
}

resource "google_compute_router_nat" "editors_nat" {
  name                               = "bionic-editors-nat"
  router                             = google_compute_router.nat_router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.editors.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

# Allow HTTPS/HTTP ingress to Bionic Hub only
resource "google_compute_firewall" "hub_public_https" {
  name    = "bionic-allow-hub-https"
  network = google_compute_network.bionic.name

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["bionic-hub-server"]
}

# Allow IAP SSH strictly for operator maintenance (no open port 22)
resource "google_compute_firewall" "iap_ssh" {
  name    = "bionic-allow-iap-ssh"
  network = google_compute_network.bionic.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["bionic-hub-server"]
}

# Allow Hub Control Plane -> Editor VMs ONLY on mTLS ports 3000 & 3002
resource "google_compute_firewall" "hub_to_editors_mtls" {
  name    = "bionic-allow-hub-to-editors-mtls"
  network = google_compute_network.bionic.name

  allow {
    protocol = "tcp"
    ports    = ["3000", "3002"]
  }

  source_tags = ["bionic-hub-server"]
  target_tags = ["bionic-editor-vm"]
}

# Allow Editor & Runner VMs -> Hub internal IP:443 ONLY (HTTPS behind Caddy; zero plaintext :4000!)
resource "google_compute_firewall" "vms_to_hub_internal" {
  name    = "bionic-allow-vms-to-hub"
  network = google_compute_network.bionic.name

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  source_ranges = [
    google_compute_subnetwork.editors.ip_cidr_range,
    google_compute_subnetwork.runners_noegress.ip_cidr_range
  ]
  target_tags = ["bionic-hub-server"]
}

# DENY ALL east-west traffic between Editor/Runner VMs (Zero lateral movement!)
resource "google_compute_firewall" "deny_east_west_vms" {
  name      = "bionic-deny-east-west-vms"
  network   = google_compute_network.bionic.name
  direction = "INGRESS"
  priority  = 900

  deny {
    protocol = "all"
  }

  source_ranges = [
    google_compute_subnetwork.editors.ip_cidr_range,
    google_compute_subnetwork.runners_noegress.ip_cidr_range
  ]
  target_tags = ["bionic-editor-vm", "bionic-runner-noegress"]
}

# DENY ALL internet egress on Reproducible Module Runner VMs (except Hub internal IP:443)
resource "google_compute_firewall" "runner_allow_hub_egress" {
  name      = "bionic-runner-allow-hub-egress"
  network   = google_compute_network.bionic.name
  direction = "EGRESS"
  priority  = 800

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  destination_ranges = [google_compute_subnetwork.hub.ip_cidr_range]
  target_tags        = ["bionic-runner-noegress"]
}

resource "google_compute_firewall" "runner_deny_all_other_egress" {
  name      = "bionic-runner-deny-all-egress"
  network   = google_compute_network.bionic.name
  direction = "EGRESS"
  priority  = 950

  deny {
    protocol = "all"
  }

  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["bionic-runner-noegress"]
}

# Private Cloud DNS Zone so Editor & Zero-NAT Runner VMs resolve hub.<domain> to Hub's internal VPC IP
resource "google_dns_managed_zone" "bionic_private" {
  name        = "bionic-hub-private-dns"
  dns_name    = "${var.domain}."
  description = "Private split-horizon DNS resolving hub.${var.domain} to internal VPC IP"
  visibility  = "private"

  private_visibility_config {
    networks {
      network_url = google_compute_network.bionic.id
    }
  }
}

resource "google_dns_record_set" "hub_internal_a" {
  name         = "hub.${var.domain}."
  managed_zone = google_dns_managed_zone.bionic_private.name
  type         = "A"
  ttl          = 60
  rrdatas      = [google_compute_instance.hub.network_interface[0].network_ip]
}

# Private Service Access VPC Peering (required when db_mode = "cloud_sql")
resource "google_compute_global_address" "private_service_access" {
  count         = var.db_mode == "cloud_sql" ? 1 : 0
  name          = "bionic-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.bionic.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  count                   = var.db_mode == "cloud_sql" ? 1 : 0
  network                 = google_compute_network.bionic.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access[0].name]
}
