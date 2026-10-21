# Certifyx Live — setup (about 30 minutes)

Website (`index.html`, `styles.css`, `app.js`, `config.js`, PWA files) + Supabase backend (`supabase/`).
Installable on phones/desktops as an app (PWA) — this replaces the old in-memory Android APK.

## Who can do what (enforced by the database and server functions, not by hidden buttons)
| | Student | Faculty |
|---|---|---|
| See data | only their own row, certificates, messages | everything |
| Upload | only for their own roll number (server forces it) | any student |
| Approve / reject / notify / broadcast / remove / sync / settings / roster | no | yes |

## Setup
1. **Supabase** → SQL Editor → run `supabase/schema.sql`, then `supabase/seed.sql`.
   Edit the `faculty_emails` insert at the top first: those Google accounts become faculty.
   *(Already ran version 1? Run `supabase/upgrade.sql` instead.)*
2. **Google sign-in**: Supabase → Authentication → Providers → Google; set Authentication → URL Configuration → Site URL to your website.
3. **Drive/Sheets access** (pick one):
   - **A. Faculty OAuth refresh token** (works with a normal My Drive folder). Authorise scopes `drive` + `spreadsheets`, then
     `supabase secrets set GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=…`
     ⚠ If the OAuth consent screen is in **Testing** mode the token expires after 7 days. Publish the app ("In production") or make it **Internal** (Google Workspace for Education). The site tells you clearly when this happens (*invalid_grant*).
   - **B. Service account** + a **Shared Drive** folder (service accounts can't own files in My Drive); share the Sheet with its email as Editor:
     `supabase secrets set GOOGLE_SERVICE_ACCOUNT='{"client_email":…,"private_key":…}'`
4. `supabase secrets set CRON_SECRET=<long random string>`
5. Deploy: `supabase functions deploy upload-certificate` · `supabase functions deploy admin-remove` · `supabase functions deploy sync-drive-sheet --no-verify-jwt`
6. Sign in as faculty → **System Controls & Settings**: paste Drive folder ID, spreadsheet ID, tab name → **Run system check** (tells you exactly what is wrong).
   Sheet columns: A time · B roll no · C name · D category · E title · F Drive link · G submission id (the site writes these).
7. `config.js`: project URL + anon key. Deploy the site files (Vercel/Netlify/GitHub Pages).
8. **Automatic sync every 5 min** (enable `pg_cron` + `pg_net`):
   ```sql
   select cron.schedule('certifyx-sync','*/5 * * * *',$$
     select net.http_post(url:='https://YOUR-PROJECT.supabase.co/functions/v1/sync-drive-sheet',
       headers:='{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb) $$);
   ```
   The header shows "Auto on/off" based on whether a cron run happened in the last 20 minutes.
9. **Link students to logins**: a student's Google email must equal `students.email` (use *Add Student* / *Batch Import* `ROLL, NAME, email`). Late additions link automatically; accounts created before the schema existed are repaired on next sign-in.

## What it does
- **Upload** (student): PDF → Drive → database → Sheet row (with a unique submission id). Sheet failure → stays "Drive only"; the next sync repairs it. Uploading the same title again **replaces** the old copy; after a rejection a re-upload resets the status to *pending review*.
- **Sync** (button / cron): flags files deleted from Drive, adds files found in Drive (roll number from the file name), pairs Sheet rows exactly (submission id → Drive link → roll+category+title → roll+category), appends missing Sheet rows, writes a report + audit log. Idempotent.
- **Needs Review**: duplicates = same student + same file name (different file names are never duplicates) and count mismatches. *Remove duplicates* trashes the Drive copy, deletes its Sheet row and the record, and tombstones it so sync never brings it back. Per-certificate delete does the same.
- **Alerts**: group / urgency / templates / compose / copy-for-WhatsApp, recent broadcasts. **Audit Logs**: sync history + every action.
- **Live updates**: faculty counts and the student's inbox update without refresh; a half-filled upload form is never reset.

## Tests (`sh run-tests.sh`)
- `tests/core.test.mjs` — 17 tests of the real server logic against fake Drive/Sheets/DB.
- `tests/e2e.py` — 39 browser checks: the real site as student and faculty against the same logic (upload, live updates, rejection/re-upload, duplicates, alerts, audit, system check, access isolation, PWA, no JS errors).

## Not covered by those tests (verify on first setup)
Real Postgres (`schema.sql` and its row-level-security policies have **not been executed**), real Google APIs, real Supabase Auth/Realtime, and Google OAuth consent. The system-check button covers Google/sheet/folder/cron/linking problems. The native Android app is still a separate in-memory app; use the installed PWA instead (or ask for the Kotlin app to be connected).
