# Deploying the frontend to Vercel

Static SPA, built by Vite, talking to Supabase directly and to the Express server
on AWS. Vercel serves files only — no serverless functions, no Vercel cron.

`frontend/vercel.json` is committed and holds everything expressible in a file.
The rest is dashboard settings and environment variables, below.

---

## Step 0 — Push the code first (currently required)

**Five files the build needs are not on GitHub yet.** A deploy right now fails at
`tsc` with "cannot find module", because Vercel builds from the *pushed* commit,
not from your disk:

| File | Imported by |
|---|---|
| `shared/schedule.ts` | `ComposeFlow.tsx`, `server/src/scheduler/schedule.ts` |
| `frontend/src/lib/sends.ts` | `ComposeFlow.tsx` |
| `frontend/src/lib/engagement.ts` | `DatabasePage.tsx` |
| `frontend/src/components/compose/StepTimingBadge.tsx` | `SequenceSidebar.tsx` |
| `frontend/src/components/common/EngagementCell.tsx` | `leadColumns.tsx` |

There are also ~19 modified files not yet committed. From the repo root:

```bash
git add -A
git commit -m "feat: reply markers, live wait-day updates, Vercel config"
git push origin main
```

Then confirm nothing sensitive went up:

```bash
git ls-files | grep -E "\.env$"      # must print NOTHING
```

Only `frontend/.env.example` and `server/.env.example` should ever be tracked.
Both are templates with no values. Your real `frontend/.env` is correctly
gitignored — it stays on your machine, and Vercel gets its values from the
dashboard instead.

**Check the repo is private** (GitHub → Settings). It's an internal tool; nothing
in it needs to be public, and the frontend bundle plus schema are easier to reason
about if the source isn't world-readable.

---

## Step 1 — Import the repository

1. Go to <https://vercel.com/new>.
2. Sign in with GitHub. If this is a new account, install the Vercel GitHub App
   and grant it access to `Email-Sending-Tool-Idea` (you can grant one repo only).
3. Find `Email-Sending-Tool-Idea` in the list and click **Import**.

Vercel will look at the repo root, find no `package.json` there, and detect no
framework. That is expected — you fix it in the next step. **Do not click Deploy
yet.**

---

## Step 2 — Set the Root Directory (the important one)

Still on the import screen, before deploying:

1. Expand the **Root Directory** section.
2. Click **Edit** and choose `frontend`, or type `frontend`.
3. Confirm **"Include source files outside of the Root Directory in the Build
   Step"** is **checked**. It is on by default for projects created after Aug 2020,
   so this is usually a verification, not a change.

**Why this checkbox is not optional here.** `frontend/vite.config.ts` aliases
`@shared` to `../shared`, which sits *outside* `frontend/`. With the box
unchecked those files are never uploaded and the build dies on the first
`@shared/...` import. Your repo has three sibling packages — `frontend/`,
`server/`, `shared/` — and this project deliberately compiles `shared/` into
both, so the frontend genuinely cannot build from `frontend/` alone.

The `server/` folder is simply ignored by Vercel. It is not built, not deployed,
and costs nothing here — it goes to AWS separately.

---

## Step 3 — Framework and build settings

Under **Build and Output Settings**:

| Setting | Value |
|---|---|
| Framework Preset | **Vite** |
| Build Command | leave default (`npm run build`) |
| Output Directory | leave default (`dist`) |
| Install Command | **leave the Override off** — `vercel.json` sets it |
| Node.js Version | 22.x (Settings → General, after import) |

### Why `vercel.json` overrides the install command

```json
"installCommand": "npm install && npm install --prefix ../shared"
```

`shared/time.ts` and `shared/schedule.ts` import `luxon`. Node, tsc and Vite all
resolve a bare specifier by walking **up** from the importing file —
`shared/node_modules`, then the repo root — never sideways into
`frontend/node_modules`. So the frontend's own `luxon` does not satisfy them;
`shared/package.json` exists precisely to give those imports somewhere to land.

This only breaks on a clean checkout, which is exactly what Vercel is. Verified
locally by deleting `shared/node_modules`:

```
../shared/schedule.ts(1,26): error TS2307: Cannot find module 'luxon'
../shared/time.ts(1,26): error TS2307: Cannot find module 'luxon'
```

With the second install it passes. Vercel runs the install command from the Root
Directory, so `../shared` resolves.

> **If the build fails with `TS2307: Cannot find module 'luxon'`,** Vercel is not
> reading `frontend/vercel.json`. The docs are ambiguous about whether
> `vercel.json` is read from the Root Directory or the repo root. Fix: in
> Settings → Build and Deployment, turn **on** the Install Command override and
> paste `npm install && npm install --prefix ../shared` there, then redeploy. The
> dashboard value is unambiguous. Same applies to the rewrite below — if a hard
> reload 404s, the file isn't being read.

---

## Step 4 — Environment variables

Add all three, scoped to **Production** (tick Preview too if you'll use preview
deploys). On the import screen there's an **Environment Variables** section; after
import it's Settings → Environment Variables.

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | your `sb_publishable_...` key |
| `VITE_SERVER_URL` | AWS backend origin, **no trailing slash** |

Copy the first two from your local `frontend/.env` — they're identical in
production. For `VITE_SERVER_URL` see Step 6.

**Only the publishable key.** Every `VITE_` variable is inlined into the
JavaScript bundle at build time and readable by any visitor — so the
`sb_secret_...` key and the Google client secret must never appear here. They
belong to the server's environment alone. The publishable key is designed to ship
this way; RLS is what actually protects your data.

Because they're inlined at **build** time, changing one requires a **redeploy**,
not a restart.

---

## Step 5 — Deploy

Click **Deploy**. Expect roughly 1–2 minutes. You'll get a URL like
`https://email-sending-tool-idea.vercel.app`.

The build log should show two `npm install` runs, then `tsc -b && vite build`, then
`✓ built`. A warning that the JS chunk exceeds 500 kB is expected and harmless —
it's ~1.3 MB raw, ~400 kB gzipped, fine for a single-user tool on a CDN.

The app will load but **cannot reach the backend yet**. That's Step 6.

---

## Step 6 — Connect the two halves

The frontend needs the backend's URL at build time; the backend needs the
frontend's URL for CORS. Break the cycle in this order:

1. **Deploy the backend to AWS**, note its public origin (`https://api.example.com`).
2. **Set `VITE_SERVER_URL`** on Vercel to that origin, then **Redeploy**
   (Deployments → ⋯ → Redeploy). A redeploy is required — editing the variable
   alone changes nothing already built.
3. **Set the backend's `FRONTEND_URL`** to your Vercel origin, **no trailing
   slash**, and restart it. This single variable does two jobs: it's the CORS
   allowed origin (`server/src/index.ts:48`) *and* the base of the OAuth success
   redirect (`server/src/auth/google.ts:318`). Wrong value ⇒ every API call fails
   CORS *and* Gmail connection dead-ends.
4. **Add the backend callback in Google Cloud Console** → Credentials → your OAuth
   client → Authorized redirect URIs, matching `GOOGLE_REDIRECT_URI` exactly. Note
   this points at the **backend**, not Vercel.

If you later add a custom domain, `FRONTEND_URL` must change with it or OAuth
returns will land on the stale `.vercel.app` host.

### Why the SPA rewrite exists

```json
"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
```

The app has no router — `view` is a `useState` in `App.tsx`. But the OAuth callback
sends the browser to `${FRONTEND_URL}/settings?connected=1`, a path that exists
only so `oauth-return.ts` can read the flag and `history.replaceState` it back to
`/`. That cleanup runs *in the app* — which can only run if the server served it
something. Without this rule the user hits a 404 mid-Gmail-connection and the app
never loads to tidy the URL. Vercel checks the filesystem before rewriting, so
hashed `/assets` files still serve as themselves.

---

## Step 7 — Verify

- `/` loads, leads table populates → Supabase vars + RLS are right.
- Console shows no CORS errors → `FRONTEND_URL` matches the Vercel origin exactly.
- Settings → Connect Gmail completes and returns with the account shown →
  `FRONTEND_URL`, redirect URI and the rewrite are all right.
- Hard-reload while on Settings → app loads, not a 404 → rewrite is active.

---

## After this: pushes deploy automatically

Every push to `main` triggers a production deploy; other branches get preview
URLs. Two consequences worth knowing:

- A push that breaks `tsc` fails the build and **leaves the previous deployment
  live** — Vercel doesn't publish broken builds.
- Preview deployments are public URLs by default. For an internal tool, consider
  Settings → Deployment Protection.

To disable auto-deploy, Settings → Git.

---

## Notes and rough edges

- **Vercel Hobby is contractually non-commercial.** This tool sends business
  outreach, which is the sort of use that plan excludes. Read the terms and decide
  deliberately — the risk is account suspension, not a surprise bill.
- **Hobby allows 1 concurrent build**, irrelevant for one project.
- **Nothing scheduled runs on Vercel.** It serves static files; the send loop is
  `node-cron` inside the long-lived Express process on AWS. If that host is ever
  replaced with something that sleeps, `POST /api/cron/tick`
  (`server/src/routes/cron.ts`, guarded by `CRON_SECRET`) is the hook an external
  scheduler would call — unused in this arrangement.
- **Supabase free plan pauses a project after ~1 week of inactivity.** A paused
  database makes the deployed frontend look broken; unpause from the Supabase
  dashboard.
