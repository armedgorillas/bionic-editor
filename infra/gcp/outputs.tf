output "hub_static_ip" {
  description = "Point A records for hub.<domain>, *.editors.<domain>, *.reports.<domain>, and public-reports.<domain> here"
  value       = google_compute_address.hub_static_ip.address
}

output "hub_service_account_email" {
  value = google_service_account.hub.email
}

output "template_bio_standard_sa_email" {
  value = google_service_account.tmpl_bio_standard.email
}

output "runner_noiam_sa_email" {
  value = google_service_account.runner_noiam.email
}

output "project_data_bucket" {
  value = google_storage_bucket.project_data.name
}

output "shared_datasets_bucket" {
  value = google_storage_bucket.shared_datasets.name
}

output "static_reports_private_bucket" {
  value = google_storage_bucket.static_reports_private.name
}

output "static_reports_public_bucket" {
  value = google_storage_bucket.static_reports_public.name
}
