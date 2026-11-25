# Deploying Folio on Railway

About 15 minutes. You need a Railway account (railway.com) and access to this GitHub repo.

## 1. Create the project
1. Railway → **New Project → Deploy from GitHub repo** → `cluen8htz-lgtm/-folio-`, branch `main`.
   Railway reads `railway.json` and builds the `Dockerfile`. The first deploy **will fail**: the
   variables aren't set yet. That's expected.
2. In the same project: **+ New → Database → PostgreSQL**.

## 2. Set variables
On the Folio service → **Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills it in from the database) |
| `APP_SECRET` | A random string of 32+ characters. Use Railway's **Generate** button, or a password manager. |
| `APP_PASSWORD` | The team's shared login password, 12+ characters. |
| `TEAM_NAME` | How your AI employees introduce the team, e.g. `Sunrise Home Buyers`. |
| `TEAM_TIMEZONE` | `America/New_York` |
| `BUSINESS_POSTAL_ADDRESS` | Your business mailing address (required in marketing email). |

When you're ready for each feature, add:
- **Claude:** `ANTHROPIC_API_KEY`
- **Texting:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`). Leave `TWILIO_DRY_RUN` unset (texts are logged, not sent) until you've tested; then set it to `false`.
- **Email:** `EMAIL_API_KEY`, `EMAIL_FROM`
- **Daily code-violation pull:** `MDC_CODE_VIOLATIONS_LAYER_URL`

Folio refuses to start with a missing database, a short secret or a short password, and the deploy log says which.

## 3. Get a URL
Folio service → **Settings → Networking → Generate Domain** (or add your own domain; Railway issues HTTPS).
Folio picks up Railway's domain automatically. If you use a custom domain, also set `PUBLIC_URL=https://your.domain`.

Redeploy. When the health check at `/api/health` passes, open the URL and sign in with `APP_PASSWORD`.

## 4. Connect Twilio (when ready)
In Twilio, set your number's (or Messaging Service's) incoming-message webhook to
`POST https://<your domain>/webhooks/twilio/inbound`. Status updates use
`/webhooks/twilio/status` automatically.

## Keep in mind
- **One instance.** `railway.json` pins 1 replica: the scheduler (automations every minute, daily imports) runs inside the app. Don't scale it up.
- **Shared password.** Everyone on the team signs in with the same password, and approvals aren't recorded per person. Change `APP_PASSWORD` when someone leaves (that signs everyone out once you also change `APP_SECRET`).
- **Backups.** Turn on backups for the Postgres service (Postgres → Backups).
- **Updates.** Every push to `main` redeploys automatically.
