packer {
  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = "~> 1.1"
    }
  }
}

variable "project_id" { type = string }
variable "zone" { type = string; default = "us-central1-a" }
variable "network" { type = string; default = "bionic-hub-vpc" }
variable "subnetwork" { type = string; default = "bionic-editors-subnet" }
variable "bionic_editor_tarball" { type = string; default = "../../bioniceditor.tgz" }
variable "bionic_hub_tarball" { type = string; default = "../../bionic-hub-daemon.tgz" }
variable "opencode_version" { type = string; default = "2.0.0" }

source "googlecompute" "bio_standard" {
  project_id          = var.project_id
  source_image_family = "ubuntu-2404-lts-amd64"
  zone                = var.zone
  network             = var.network
  subnetwork          = var.subnetwork
  omit_external_ip    = false
  machine_type        = "e2-standard-2"
  disk_size           = 30
  ssh_username        = "packer"
  image_family        = "bionic-bio-standard"
  image_name          = "bionic-bio-standard-{{timestamp}}"
  image_description   = "Bionic Hub Golden VM Image (Ubuntu 24.04 + Two-Unit Systemd + nftables IMDS guard + Pinned OpenCode V2)"
}

build {
  sources = ["source.googlecompute.bio_standard"]

  provisioner "file" {
    source      = var.bionic_editor_tarball
    destination = "/tmp/bioniceditor.tgz"
  }

  provisioner "file" {
    source      = var.bionic_hub_tarball
    destination = "/tmp/bionic-hub-daemon.tgz"
  }

  provisioner "shell" {
    environment_vars = [
      "OPENCODE_VERSION=${var.opencode_version}"
    ]
    script = "scripts/provision.sh"
  }
}
