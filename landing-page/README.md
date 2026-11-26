# Bionic Editor Landing Page (`editor.rightbionic.com`)

Self-contained, zero-build static landing page for **Bionic Editor** and **Bionic Hub**, styled to match `rightbionic.com` (light + dark mode, `Manrope` typography, sticky "On this page" navigation, and click-to-zoom screenshots).

## Local Preview

```bash
python3 -m http.server 8080 --directory landing-page
# Open http://localhost:8080
```

## Deployment

Deploy the `landing-page/` folder directly to any static host (Cloudflare Pages, GCS static bucket + CDN, Netlify, S3/CloudFront, GitHub Pages, or Caddy/Nginx) pointed at `editor.rightbionic.com` — no build step required.
