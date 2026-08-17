# Deploying to Google Cloud (Cloud Run + Cloud SQL)

## Overview

Docreview runs on GCP as a Docker container on **Cloud Run** backed by a **Cloud SQL**
PostgreSQL database. The setup works like this:

- **Cloud Run** serves the Next.js app as a serverless container. It scales to zero when idle
  (no cost), auto-scales under load, and provides HTTPS with a `*.run.app` domain.
- **Cloud SQL** hosts the PostgreSQL database. Cloud Run connects to it via a Unix socket
  provided by the built-in Cloud SQL proxy — no public IP or VPN needed.
- **Artifact Registry** stores the Docker images built from the source code.
- **Cloud Build** builds the Docker image from the `Dockerfile` when you deploy with
  `--source .`. You don't need to build or push images manually.

The app uses the same Google OAuth credentials as local development. The only difference is
the redirect URI (the Cloud Run URL instead of `localhost:3000`).

### How the container starts

On each deploy, Cloud Build creates a new Docker image using the multi-stage `Dockerfile`:

1. **Build stage**: Installs dependencies, generates the Prisma client (with Alpine-compatible
   engine binaries), and builds the Next.js standalone output.
2. **Runtime stage**: A minimal Alpine image with just the standalone build output, static
   assets, Prisma schema/migrations, and the Prisma CLI.

When the container starts, `docker-entrypoint.sh` runs `prisma migrate deploy` to apply any
pending database migrations, then starts the Next.js server on port 8080.

### Access control

- `--allow-unauthenticated` lets public traffic reach the app (required so users can see the
  login page). The app handles its own authentication via NextAuth/Google OAuth.
- The `ALLOWED_EMAILS` env var restricts which Google accounts can sign in. If unset, any
  Google account is allowed.

### Cost

- **Cloud Run**: Free tier covers ~2M requests/month. Scales to zero when idle.
- **Cloud SQL**: The `db-f1-micro` tier is the smallest instance (~$7/month). This is the
  main cost.

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI) installed and authenticated
- A GCP project with billing enabled

## One-time GCP setup

### 1. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com
```

- `run.googleapis.com` — Cloud Run (serves the app)
- `sqladmin.googleapis.com` — Cloud SQL Admin (manages the database)
- `artifactregistry.googleapis.com` — Artifact Registry (stores Docker images)

### 2. Create a Cloud SQL PostgreSQL instance

```bash
gcloud sql instances create docreview-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1

gcloud sql databases create docreview --instance=docreview-db
gcloud sql users set-password postgres --instance=docreview-db --password=YOUR_PASSWORD
```

`db-f1-micro` is the smallest/cheapest tier. Use `db-g1-small` or larger if you need more
capacity.

### 3. Update Google OAuth settings

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), add your
Cloud Run URL as an authorized redirect URI:

```
https://docreview-XXXXX-uc.a.run.app/api/auth/callback/google
```

You'll get the exact URL after the first deploy. You can come back to this step then.

## Initial deploy

```bash
gcloud run deploy docreview \
  --source . \
  --region us-central1 \
  --add-cloudsql-instances YOUR_PROJECT:us-central1:docreview-db \
  --set-env-vars "DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost/docreview?host=/cloudsql/YOUR_PROJECT:us-central1:docreview-db" \
  --set-env-vars "AUTH_SECRET=YOUR_SECRET" \
  --set-env-vars "AUTH_GOOGLE_ID=YOUR_ID" \
  --set-env-vars "AUTH_GOOGLE_SECRET=YOUR_SECRET" \
  --set-env-vars "AUTH_URL=https://docreview-XXXXX-uc.a.run.app" \
  --set-env-vars "AUTH_TRUST_HOST=true" \
  --set-env-vars "^##^ALLOWED_EMAILS=you@gmail.com,coworker@gmail.com" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi
```

### Notes on env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Must include `@localhost` — Prisma's URL parser requires a host. The `?host=` parameter directs it to use the Cloud SQL Unix socket instead of TCP. |
| `AUTH_SECRET` | Encrypts NextAuth sessions. Generate with `pnpm dlx auth secret`. |
| `AUTH_GOOGLE_ID` | Google OAuth client ID (from Cloud Console). |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret. |
| `AUTH_URL` | The public URL of the app. Required for OAuth callbacks to work behind Cloud Run's load balancer. |
| `AUTH_TRUST_HOST` | Must be `true` when running behind a reverse proxy (Cloud Run). |
| `ALLOWED_EMAILS` | Optional comma-separated whitelist of Google accounts that can sign in. If unset, all accounts are allowed. |

### Setting AUTH_URL after first deploy

If you don't know the Cloud Run URL yet, omit `AUTH_URL` from the initial deploy and set it
after:

```bash
gcloud run services update docreview \
  --region us-central1 \
  --update-env-vars "AUTH_URL=https://docreview-XXXXX-uc.a.run.app"
```

Then add the callback URL to your Google OAuth redirect URIs (see step 3 above).

## Subsequent deploys

After code changes, redeploy with:

```bash
gcloud run deploy docreview --source . --region us-central1
```

Cloud Run retains env vars and the Cloud SQL connection from the initial deploy. Only the
image is rebuilt and replaced. Database migrations run automatically on container startup.

### Updating env vars

Use `--update-env-vars` (not `--set-env-vars`) to change individual env vars without
affecting the others. `--set-env-vars` **replaces all** env vars.

```bash
gcloud run services update docreview \
  --region us-central1 \
  --update-env-vars "^##^ALLOWED_EMAILS=you@gmail.com,new-user@gmail.com"
```

The `^##^` prefix changes the delimiter from `,` to `##` so that commas in the email list
aren't interpreted as env var separators by `gcloud`.

To see what's currently set:

```bash
gcloud run services describe docreview --region us-central1 \
  --format="value(spec.template.spec.containers[0].env)"
```

## Viewing logs

Cloud Run streams all stdout/stderr to Cloud Logging. View logs in the
[GCP Console](https://console.cloud.google.com/run) under your service's Logs tab, or via CLI:

```bash
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=docreview" \
  --limit 50 \
  --format="table(timestamp,textPayload)"
```

The app also writes to log files inside the container (`/app/logs/`), but these are ephemeral
and lost on container restart. The console output captured by Cloud Logging is the primary
log source in production.

## Connecting to the database

```bash
# Interactive psql session via Cloud SQL Auth Proxy
gcloud sql connect docreview-db --user=postgres

# Or use Cloud SQL Studio in the GCP Console for a browser-based SQL editor
```

## Troubleshooting

### Container fails to start (PORT timeout)

Check logs for the specific error. Common causes:
- **Missing env vars** — `DATABASE_URL` not set or malformed
- **Database unreachable** — Cloud SQL instance not running, or `--add-cloudsql-instances` not set on the service
- **Prisma engine missing** — ensure `binaryTargets` in `prisma/schema.prisma` includes `linux-musl-openssl-3.0.x` for Alpine

### Authentication errors (P1000)

Password mismatch between `DATABASE_URL` and Cloud SQL. Reset the password:

```bash
gcloud sql users set-password postgres --instance=docreview-db --password=YOUR_PASSWORD
```

### OAuth callback returns 500

- Check that `AUTH_URL` matches the actual Cloud Run URL
- Check that the callback URL is listed in Google OAuth redirect URIs
- Check that `AUTH_TRUST_HOST=true` is set
