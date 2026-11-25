# Folio

An operating system for a real estate investing team in Miami-Dade. It pulls distressed-property signals from county records, scores every parcel, and gives the team AI employees that draft and send follow-up. Every message passes compliance checks, and each employee only acts on its own after earning trust.

## What it does (phase 1)

| Area | What's built |
|---|---|
| **Lead data** | CSV import for foreclosure / lis pendens, probate, tax certificate and code violation exports, with columns matched by name. A live, paged ArcGIS pull for code violations. Properties are deduped on the 13-digit folio, and re-imports never double-count. |
| **Scoring** | A deterministic 0–100 motivation score with readable reasons: strongest signal, +15 per stacked signal type, +10 if recent, up to +15 for amount owed, +10 for an absentee owner. |
| **Skip trace** | Import any vendor's CSV (folio → phone / email / DNC flag). |
| **CRM** | Leads list with filters, a lead page (records, conversation, contact, consent, prices) and a drag-and-drop pipeline. |
| **AI employees** | Named roles with a trust level per action: **ask → draft → act**. A promotion is suggested only after 10/25+ reviewed actions with ≥90% approved unchanged. |
| **Approvals** | Edit, approve or reject drafts. Edits are distilled into team "memory" that shapes later drafts, and so are rejection reasons. |
| **Automations** | Type a plan in one sentence. Claude compiles it into a structured spec, the code validates it, and you review the read-back before turning it on. The engine handles waits, sends, stop-if-replied, stage moves and tasks. |
| **Twilio** | Outbound SMS, signed inbound and status webhooks, STOP/START handling, and a dry-run mode (on by default). |
| **Email** | Sending through a Resend-compatible API, with a CAN-SPAM footer and a one-click unsubscribe. |

**Not built yet (later phases):** AI-built reports and boards, contract filling with e-signature, multi-team accounts, and live connectors for the Clerk and Tax Collector (those use file exports for now).

## Compliance guardrails (enforced in code)

These are a floor, not legal advice. Have a Florida TCPA/FTSA attorney review your outreach before you send.

- **Florida FTSA**: texts only between 8am and 8pm recipient local time, and at most 3 per person in 24 hours. Anything outside that is held and re-checked at send time.
- **Consent**: a number from public records or skip tracing has consent `none`. Those texts are *never* sent automatically, whatever the employee's trust level. A person approves each one. When the owner replies, the contact moves to `inbound`.
- **DNC**: numbers flagged on the registry are blocked unless there's consent.
- **Opt-out**: STOP (and phrases like "remove me") opts the contact out, cancels anything queued and stops their automations.
- **Drafting rules**: Claude never mentions foreclosure, probate, liens, death or debt to the owner, never impersonates anyone, and never invents offers.
- You still need **A2P 10DLC registration** with Twilio before carriers will deliver your texts.

## How it decides

Claude only writes text and reads replies. Ordinary, unit-tested code decides what happens: `server/core/compliance.ts`, `trust.ts`, `scoring.ts` and `automation-spec.ts`. Everything outbound goes through `server/services/outbox.ts`:

```
draft → compliance (block / defer / ok) → trust gate (propose / draft / execute) → send-time re-check → Twilio
```

## Run it

```bash
cp .env.example .env       # set APP_PASSWORD, APP_SECRET, TEAM_NAME at minimum
npm ci
npm run dev                # API on :3000, web on http://localhost:5173
```

Leave `DATABASE_URL` empty in development to use an embedded Postgres (PGlite) in `./data`. In production, point it at Postgres; migrations run on boot.

**Hosting:** see [DEPLOY.md](DEPLOY.md) for Railway (step by step). Any Docker host works: `docker build -t folio . && docker run -p 3000:3000 --env-file .env folio`.

Run a single instance: the scheduler (automations every minute, imports daily) runs in-process.

### Twilio setup
1. Register your brand and campaign (A2P 10DLC) and buy a number.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`), plus `PUBLIC_URL`.
3. Point the number's incoming-message webhook to `POST {PUBLIC_URL}/webhooks/twilio/inbound`.
4. Set `TWILIO_DRY_RUN=false` when you're ready to send for real.

### Miami-Dade data
- **Code violations (live):** find the current code compliance layer on the county's open data portal and set `MDC_CODE_VIOLATIONS_LAYER_URL` to its ArcGIS REST layer URL (ending in `/FeatureServer/<n>` or `/MapServer/<n>`). Test it with **Data → Pull code violations now**.
- **Foreclosures, probate, tax liens:** export searches from the Clerk of Court and Tax Collector sites (or a list vendor) as CSV and upload them under **Data**. The preview shows how the columns mapped before anything is saved. If a column doesn't map, add its header to `COLUMNS` in `server/connectors/miami-dade/mapping.ts`.

## Development

```bash
npm test          # unit + end-to-end tests (in-memory Postgres)
npm run check     # TypeScript
npm run build     # web + server bundle into dist/
```
