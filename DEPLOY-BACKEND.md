# Deploying the backend (AWS EC2) — step by step

Follow this top to bottom. The frontend is already live on Vercel
(`outreach-tool-teal.vercel.app`); this guide gets the Express server onto AWS,
gives it HTTPS, and connects the two.

Estimated time: **2–3 hours** the first time, most of it waiting on DNS and
Google's consent screen.

**Already deployed and something changed?** Don't re-read this top to bottom —
jump to the runbook:

- **New EC2 box or new AWS account** → [Runbook: the EC2 instance changed](#runbook-the-ec2-instance-changed-new-box-or-a-new-aws-account)
- **New domain** → [Runbook: the domain changed](#runbook-the-domain-changed)
- **Backups you should already have** → [Back this up now](#back-this-up-now-both-runbooks-below-depend-on-it)

---

## Read this first: three things that will bite you

**1. Your backend must be HTTPS, not HTTP.** The frontend is on `https://`.
Browsers block `https://` pages from calling `http://` APIs (mixed content) — no
error you can fix in code, the request simply never leaves. So plain
`http://<ec2-ip>:8080` will not work, and Steps 6–8 exist entirely to solve this.

**2. You cannot get a certificate for an AWS hostname.** Let's Encrypt
permanently refuses `*.compute.amazonaws.com` — those names change hands, so
issuing for them is forbidden by policy. You need a domain name you control.
Step 5 uses a subdomain of your own domain — **not** a free dynamic-DNS host like
DuckDNS. That choice is about deliverability, not convenience: see Step 5.

**3. Check which AWS free tier you have** — it changes what you can run:

| | Account before 15 Jul 2025 | Account on/after 15 Jul 2025 |
|---|---|---|
| Duration | 12 months | **6 months, then AWS closes the account** |
| Limits | 750 h/mo `t2.micro`/`t3.micro` | $100 credit + up to $100 earned |
| Overage | pay-as-you-go | can't exceed; account expires |

Find your account creation date: Billing Console → Account. If you're on the
newer plan, **this server stops existing in 6 months** unless you upgrade to a
paid plan. Plan for it now rather than discovering it when sends stop.

Either way a `t3.micro` running 24/7 plus one Elastic IP fits inside the free
allowance (750 h/month covers one always-on instance, and public IPv4 is included
for EC2 while free tier is active). **Set a billing alarm in Step 1 anyway.**

---

## Step 1 — Billing alarm (do this before anything else)

Five minutes now against an unbounded bill later.

1. AWS Console → **Billing and Cost Management** → **Billing preferences**.
2. Tick **Receive AWS Free Tier alerts**, enter your email, **Save**.
3. Go to **Budgets** → **Create budget** → **Use a template** → **Zero spend budget**.
4. Enter your email → **Create budget**.

You'll now get an email the moment anything costs money.

---

## Step 2 — Launch the EC2 instance

Console → **EC2** → **Instances** → **Launch instances**.

| Field | Value |
|---|---|
| Name | `outreach-server` |
| AMI | **Ubuntu Server 24.04 LTS** (must say "Free tier eligible") |
| Architecture | 64-bit (x86) |
| Instance type | `t3.micro` (or `t2.micro` on the older tier) |
| Key pair | **Create new key pair** → name `outreach-key`, type **RSA**, format **.pem** |
| Storage | 8 GiB `gp3` (default) |

The `.pem` file downloads once. **If you lose it you cannot SSH in again** —
you'd have to rebuild the instance. Save it somewhere permanent, e.g.
`C:\Users\udity\.ssh\outreach-key.pem`.

### Network settings — click Edit

Create a security group named `outreach-sg` with exactly three inbound rules:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | your admin access only |
| HTTP | 80 | Anywhere `0.0.0.0/0` | Let's Encrypt validation + redirect to HTTPS |
| HTTPS | 443 | Anywhere `0.0.0.0/0` | the actual API and tracking pixel |

**Do not open 8080.** Node listens on 8080 but only on localhost; Caddy
(Step 6) is what faces the internet. Opening 8080 would expose the app
unencrypted and bypass your certificate.

Port 80 must be open to the world, not just your IP — Let's Encrypt validates
from multiple undisclosed IPs and will fail otherwise.

Click **Launch instance**.

---

## Step 3 — Elastic IP (so the address survives a reboot)

A default EC2 public IP **changes every time the instance stops and starts**.
That would break your certificate, your Google redirect URI and every tracking
link already sitting in someone's inbox.

1. EC2 → **Elastic IPs** → **Allocate Elastic IP address** → **Allocate**.
2. Select it → **Actions** → **Associate Elastic IP address**.
3. Choose your `outreach-server` instance → **Associate**.

Write the IP down. Referred to below as `<EIP>`.

> An Elastic IP is free **only while attached to a running instance**. If you
> ever stop the instance, release the IP or it starts costing $0.005/hour.

---

## Step 4 — Connect over SSH

From Git Bash on Windows:

```bash
chmod 400 ~/.ssh/outreach-key.pem
ssh -i ~/.ssh/outreach-key.pem ubuntu@<EIP>
```

Type `yes` at the fingerprint prompt. You should land on a prompt like
`ubuntu@ip-172-31-x-x:~$`.

If it hangs: the security group's SSH source is probably a stale "My IP" — your
home IP changed. Update the rule.

---

## Step 5 — A domain name (needed for HTTPS)

**Use a domain you own.** Two A records, both pointing at `<EIP>`, both served by
the one Caddy on the one box:

| Host | Becomes | Used for |
|---|---|---|
| `api` | `api.yourdomain.com` | the Express API — `VITE_SERVER_URL`, `GOOGLE_REDIRECT_URI` |
| `track` | `track.yourdomain.com` | pixel + click links — `TRACKING_BASE_URL` |

At most registrars the **Host** field takes only the subdomain: type `api`, not
`api.yourdomain.com`, or you get `api.yourdomain.com.yourdomain.com`. Leave the
apex (`@`) alone — that's for a website, not this. TTL 300 while you're setting up.

The live deployment uses `api.udityakumar.dev` and `track.udityakumar.dev`.

### Why not DuckDNS (or any free dynamic-DNS host)

Earlier revisions of this guide recommended DuckDNS. **Don't.** It works for
HTTPS and fails at the actual job:

- `duckdns.org` is a shared parent domain used heavily for phishing and malware
  C2. Malwarebytes blocks its subdomains wholesale; DuckDNS hostnames appear on
  threat-intel blacklists daily. You inherit that reputation and cannot influence
  it — Spamhaus DBL wildcards list at the main-domain level.
- Filters see a `@gmail.com` From with links on an unrelated, abused domain. That
  is the exact shape of phishing, and it is ranked a top deliverability risk.
- Network-level DNS filters block it outright. FortiGuard on a college/corporate
  network resolves `duckdns.org` to a block page (`208.91.112.55`) with a
  self-signed Fortinet cert, so **the recipient cannot reach your content at
  all** — and the frontend's fetch to the API dies with `ERR_CERT_AUTHORITY_INVALID`.
  Both look like a broken app, not a blocked domain.

A domain is ~₹1,000/year and is the single highest-impact deliverability change
available here. A brand-new domain has no history, though — put a real site on
the apex and let it age a week or two before running outreach volume through
`track.`. Test sends to yourself are fine immediately.

Full alignment would mean sending from `you@yourdomain.com` (Workspace, or a
Gmail send-as) so the From and link domains match. An owned tracking subdomain
with a Gmail From is the large improvement; that's the remaining one.

### Verify DNS before continuing

**Do not proceed until both names resolve** — Caddy's certificate request in
Step 8d will fail, and repeated failures hit Let's Encrypt rate limits.

```bash
dig +short api.yourdomain.com
dig +short track.yourdomain.com
```

Both must print `<EIP>`. If a name resolves to something odd — `208.91.112.55`,
say — your local resolver is intercepting. `dig` and `nslookup` both go through
it, so check over DNS-over-HTTPS, which bypasses it:

```bash
curl -s "https://dns.google/resolve?name=api.yourdomain.com&type=A"
```

From here on, `<DOMAIN>` means `api.yourdomain.com` and `<TRACK_DOMAIN>` means
`track.yourdomain.com`.

---

## Step 6 — Install Node, Caddy and the code

All commands run on the EC2 box.

### 6a. System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git
```

### 6b. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # must print v22.x
```

### 6c. Caddy (the HTTPS reverse proxy)

Caddy rather than nginx + certbot because it obtains and renews the certificate
automatically, with no cron job to forget.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 6d. Clone the repository

If the repo is private, generate a deploy key:

```bash
ssh-keygen -t ed25519 -C "ec2-outreach" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that public key → GitHub → your repo → **Settings** → **Deploy keys** →
**Add deploy key** → paste, leave write access **off** → **Add key**. Then:

```bash
cd ~
git clone git@github.com:uditya-kumar/Email-Sending-Tool-Idea.git app
cd app
```

(For a public repo, just use the `https://` clone URL and skip the key.)

### 6e. Install dependencies

Two installs, for the same reason as on Vercel: `shared/*.ts` imports `luxon`,
and bare specifiers resolve by walking **up** from the importing file —
`shared/node_modules`, never sideways into `server/node_modules`.

```bash
cd ~/app/server && npm install
cd ~/app/shared && npm install
```

---

## Step 7 — The server's environment file

Generate the two secrets first and keep the output visible:

```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('TRACKING_HMAC_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

> **`TOKEN_ENCRYPTION_KEY` is write-once in practice.** It encrypts the stored
> Gmail refresh token with AES-256-GCM. Change it later and that token becomes
> permanently undecryptable — you'd have to reconnect Gmail. Back it up.

Now create the file:

```bash
nano ~/app/server/.env
```

Paste this, substituting your values:

```
PORT=8080
NODE_ENV=production
LOG_LEVEL=info
TZ=UTC

SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...

GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=https://<DOMAIN>/api/auth/google/callback

TOKEN_ENCRYPTION_KEY=<from the command above>
TRACKING_HMAC_SECRET=<from the command above>

TRACKING_BASE_URL=https://<TRACK_DOMAIN>
FRONTEND_URL=https://outreach-tool-teal.vercel.app

SCHEDULER_ENABLED=true
CRON_SECRET=
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`. Then lock it down:

```bash
chmod 600 ~/app/server/.env
```

Notes on specific values:

- **`SUPABASE_SECRET_KEY`** — Supabase dashboard → Project Settings → API keys →
  the `sb_secret_...` one. It bypasses RLS entirely. It belongs here and nowhere
  else; never in any `VITE_` variable.
- **`FRONTEND_URL`** — no trailing slash. This single value is both the CORS
  allowed origin (`server/src/index.ts:48`) and the base of the OAuth success
  redirect (`server/src/auth/google.ts:318`).
- **`TRACKING_BASE_URL`** — the origin baked into every pixel and click link, so
  it's `track.`, not `api.`. Once emails are sent with it, changing it breaks
  tracking on those messages: old pixels and links still point at the old host.
  If you ever do have to move it, keep a Caddy site block for the **old** name
  proxying to the same backend, or previously-sent links start 404-ing.
- **`CRON_SECRET`** — leave blank. `POST /api/cron/tick` then refuses all
  requests (fails closed), which is correct: `node-cron` runs in-process here.
- **`TZ=UTC`** — all IST maths goes through Luxon with an explicit zone, but the
  host stays on UTC so logs and stray `Date` arithmetic agree with Postgres.

Every one of these is zod-parsed at boot (`server/src/env.ts`). A missing or
malformed value makes the server refuse to start and print the exact field name.

---

## Step 8 — Build, and run under systemd

### 8a. Add swap first (the build will not fit in 1 GB otherwise)

`t3.micro` has **1 GB of RAM** and Ubuntu's EC2 images ship with **no swap at
all**. `tsc` compiles `server/` and `shared/` as one program and needs more than
that, so an unprepared build dies like this:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
Aborted (core dumped)
```

Nothing is wrong with the code when that happens — the machine simply ran out of
memory. Create a 2 GB swap file:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
free -h
```

`free -h` must now show `2.0Gi` on the Swap row. Make it survive reboots:

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Worth keeping permanently rather than only for the build: 1 GB is tight for Node
plus Caddy, and swap turns a would-be OOM kill mid-send into merely slow.

### 8b. Build (never run `tsx` in production)

```bash
cd ~/app/server && NODE_OPTIONS=--max-old-space-size=2048 npm run build
```

**Swap alone is not enough** — Node sizes its default heap from *physical* RAM, so
on a 1 GB box it caps itself near 512 MB and dies at the same point regardless of
how much swap exists. The flag raises that ceiling to 2 GB, which the swap file
now backs. Expect it to take a minute or two; swap is disk.

Since every rebuild on this box needs it, make it the default for your shell:

```bash
echo 'export NODE_OPTIONS=--max-old-space-size=2048' >> ~/.bashrc
source ~/.bashrc
```

Plain `npm run build` works from then on. This only affects interactive shells —
the service below sets its own environment and doesn't need the flag, because
*running* the compiled JavaScript costs a fraction of what compiling it did.

Check the output landed where systemd will look for it:

```bash
ls dist/server/src/index.js dist/shared/
```

Both must exist. `dist/shared/` is the proof that `shared/` compiled alongside
(`server/tsconfig.json` sets `rootDir: ".."`), and it's why the entry point is
the nested `dist/server/src/index.js` and not `dist/index.js`.

Building rather than running TypeScript directly means a type error fails here,
loudly, instead of shipping as a live process.

> If it still OOMs after both changes, stop fighting the box: run
> `npm run build` on your laptop and copy the result up with
> `scp -i ~/.ssh/outreach-key.pem -r server/dist ubuntu@<EIP>:~/app/server/`.
> Rarely necessary.

### 8c. The service file

```bash
sudo nano /etc/systemd/system/outreach.service
```

```ini
[Unit]
Description=Outreach email server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/app/server
ExecStart=/usr/bin/node dist/server/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`Restart=always` matters: the app deliberately keeps running on an unhandled
rejection in production, and systemd covers the case where it dies anyway.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now outreach
sudo systemctl status outreach
```

You want `Active: active (running)`. Check it actually booted:

```bash
curl http://localhost:8080/healthz
```

Expect exactly `{"ok":true,"scheduler":true}`. `scheduler: false` means
`SCHEDULER_ENABLED` isn't `true` and nothing will ever send. If the service is
dead, read the reason:

```bash
sudo journalctl -u outreach -n 50 --no-pager
```

A config error prints `Invalid server environment` and names the field.

### 8d. Caddy in front

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the whole file with one block per hostname — the blank line between them
matters:

```
api.yourdomain.com {
	reverse_proxy localhost:8080
}

track.yourdomain.com {
	reverse_proxy localhost:8080
}
```

That's genuinely all — Caddy fetches both certificates on reload and renews them
forever. One process, one port, two names.

```bash
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

`ExecReload` must show `status=0/SUCCESS`. Certificate issuance takes 10–30s;
watch it with `sudo journalctl -u caddy -n 40 --no-pager` and look for
`certificate obtained successfully`. If the reload itself fails,
`caddy validate --config /etc/caddy/Caddyfile` names the syntax error.

`--no-pager` on both commands avoids the `...skipping...` pager (press `q` if you
land in it anyway).

Then from **your own machine**, not the EC2 box:

```bash
curl https://<DOMAIN>/healthz
```

The same `{"ok":true,"scheduler":true}` over `https://` with no certificate
warning means Steps 2–8 are done. If it fails, check `sudo journalctl -u caddy -n 50 --no-pager` — the
usual cause is DNS not yet pointing at `<EIP>`, port 80 not open to `0.0.0.0/0`,
or Caddy never having been reloaded after the Caddyfile changed.

**If you're on a filtered network** (college/corporate wifi), a failure here may
be your own network, not the server. Test from mobile data, or confirm the
certificate from outside with an external scanner:

```bash
curl -s "https://api.ssllabs.com/api/v3/analyze?host=api.yourdomain.com&startNew=on"
# wait ~2 min, then poll without startNew:
curl -s "https://api.ssllabs.com/api/v3/analyze?host=api.yourdomain.com&fromCache=on"
```

A `certs[0].subject` of `CN=api.yourdomain.com` issued by `O=Let's Encrypt`
proves the server is right regardless of what your local network says.

The app trusts `X-Forwarded-For` (`app.set("trust proxy", 1)`), which is exactly
right for one proxy hop, so client IPs in logs stay accurate.

---

## Step 9 — Point Google at the new callback

Google Cloud Console → **APIs & Services** → **Credentials** → your OAuth 2.0
Client ID.

Under **Authorized redirect URIs**, add:

```
https://<DOMAIN>/api/auth/google/callback
```

It must match `GOOGLE_REDIRECT_URI` **byte for byte** — Google compares it as a
literal string, and any difference fails the exchange with
`redirect_uri_mismatch`. Keep the localhost entry too, for local development.

**Save**, then wait a minute or two for it to take effect.

Also confirm on the **OAuth consent screen** page that publishing status is **In
production**. In *Testing* mode Google expires refresh tokens after 7 days and
your sending silently stops. Publish it; do **not** submit for verification — for
your own account the unverified warning is expected and harmless.

---

## Step 10 — Point the frontend at the backend

Vercel dashboard → your project → **Settings** → **Environment Variables**.

Edit `VITE_SERVER_URL` from `http://localhost:8080` to:

```
https://<DOMAIN>
```

No trailing slash. Then **Deployments** → latest → **⋯** → **Redeploy**.

The redeploy is mandatory. Vite inlines `VITE_` variables into the bundle at
build time, so the already-built JavaScript still contains the old value until
it's rebuilt.

---

## Step 11 — Verify end to end

Open `https://outreach-tool-teal.vercel.app` and check each in order:

1. **Leads table loads** → Supabase and RLS fine (this already worked).
2. **Open DevTools → Console. No CORS errors.** A CORS error here means
   `FRONTEND_URL` on the server doesn't exactly match the Vercel origin.
3. **Settings → Connect Gmail** → consent → returns to the app with your
   address shown → `GOOGLE_REDIRECT_URI`, the Google Console entry and
   `FRONTEND_URL` all agree.
4. **Hard-reload on Settings** → app loads, not a 404 → the Vercel SPA rewrite
   is live.
5. **Send one test email to yourself**, open it, click a link. Then confirm the
   events landed:

```sql
select type, created_at from events order by created_at desc limit 5;
```

Opens may take a moment (Gmail proxies images) and are unreliable in general —
clicks and replies are the signals worth trusting.

---

## Step 12 — Before real outreach (currently unsafe defaults)

Three things are still set for testing. Check the current state:

```sql
select outreach_days, follow_up_days, jitter_min_seconds, jitter_max_seconds
from settings;
```

**a. Sending days are every day.** Right now both are `{0,1,2,3,4,5,6}`,
including weekends — deliberate for testing, wrong for outreach. Restore:

```sql
update settings
   set outreach_days  = '{0,1,2,3}',
       follow_up_days = '{0,1,2,3,4}'
 where user_id = (select user_id from settings limit 1);
```

(`settings` is keyed by `user_id`, and PostgREST rejects an unfiltered update —
hence the `where`.)

**b. Check the daily cap.** It lives on the Gmail account, not `settings`:

```sql
select email, daily_limit from gmail_accounts_public;
```

Start at **5/day**, then 10, then 15 over two weeks. A brand-new sending pattern
at volume is what gets accounts flagged; the 500/day Gmail ceiling is nowhere
near the practical limit.

**c. Cancel any leftover test sends** before they go out for real:

```sql
select id, lead_id, step_position, scheduled_at, subject_rendered
  from sends where status = 'pending' order by scheduled_at;
```

There is at least one queued send with a **blank subject and body** to
`uditya204+track@gmail.com`. Delete anything you don't want delivered:

```sql
delete from sends where id = '<id>';
```

**d. Regenerate DB types and typecheck** against the production project:

```bash
cd ~/app/server && npm run db:types && npm run typecheck
```

---

## Operating it

**Deploying a change:**

```bash
cd ~/app && git pull
cd server && npm install && npm run build
sudo systemctl restart outreach
```

If `shared/package.json` changed, also `cd ~/app/shared && npm install`.

The rebuild relies on the `NODE_OPTIONS` export from Step 8b being in your
`~/.bashrc`. If a build ever OOMs again — say after a `cron`ed deploy or in a
shell that didn't read the profile — pass it inline:
`NODE_OPTIONS=--max-old-space-size=2048 npm run build`.

**Logs:**

```bash
sudo journalctl -u outreach -f              # live
sudo journalctl -u outreach --since "1 hour ago" --no-pager
```

**Is the scheduler ticking?** It runs every minute:

```bash
sudo journalctl -u outreach --since "5 min ago" --no-pager | grep -i tick
```

**Reboot behaviour:** both services are `enable`d, so they come back
automatically, and the Elastic IP means the address doesn't move.

---

## Back this up now (both runbooks below depend on it)

The EC2 box is **disposable**; two strings on it are not. Copy these into a
password manager today, because losing them is the only part of a rebuild that
cannot be undone:

| Value | Lose it and… |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | the stored Gmail refresh token is permanently undecryptable (AES-256-GCM). Recoverable only by reconnecting Gmail in Settings. |
| `TRACKING_HMAC_SECRET` | every click link in **already-sent** mail fails `verify()` and 400s (`tracking-links.ts:72`). Opens still work — the pixel isn't signed. Unrecoverable. |
| `outreach-key.pem` | no SSH into the existing box, ever. |

Everything else regenerates or is stored elsewhere:

- **Database, leads, sends, events, encrypted Gmail tokens** → Supabase, not EC2.
- **Frontend** → Vercel, built from git.
- **Server code** → git.
- `SUPABASE_SECRET_KEY`, `GOOGLE_CLIENT_SECRET` → re-readable from their consoles.

Easiest complete backup, run on the box:

```bash
cat ~/app/server/.env
```

Save that output somewhere safe. It *is* the migration payload.

---

## Runbook: the EC2 instance changed (new box, or a new AWS account)

Use this when the free tier expires, the account closes, or the instance is lost.
**Nothing about the emails you've already sent breaks here** — sent mail contains
hostnames, never the IP — so if you keep the same domain, recipients can't tell
this happened.

An Elastic IP **cannot move between AWS accounts**, so a new account always means
a new IP, and DNS is what makes that invisible.

1. **Rebuild the box: Steps 1–4, then 6–8.** Skip Step 5 (you already own the
   domain) and skip the Caddyfile-content part of 8d until step 3 below. Same
   instance type, same Ubuntu, same swap — 1 GB without swap cannot run `tsc`.
2. **Allocate a new Elastic IP** and associate it (Step 3). Note it as `<EIP>`.
   Open **22, 80 and 443** in the security group; 80 is not optional, Let's
   Encrypt validates over it.
3. **Repoint DNS first, before touching Caddy.** At the registrar, edit both A
   records — `api` and `track` — to the new `<EIP>`. Then wait for it:

   ```bash
   curl -s "https://dns.google/resolve?name=api.yourdomain.com&type=A"
   curl -s "https://dns.google/resolve?name=track.yourdomain.com&type=A"
   ```

   Both must show the new IP. Reloading Caddy before this resolves burns failed
   ACME attempts against a rate limit, and the fix is then just waiting.
4. **Restore `server/.env` verbatim from your backup.** Reuse
   `TOKEN_ENCRYPTION_KEY` and `TRACKING_HMAC_SECRET` — do **not** generate fresh
   ones (see the table above). Every other value is unchanged: same domain, so
   `GOOGLE_REDIRECT_URI` and `TRACKING_BASE_URL` still describe reality.
5. **Caddyfile, systemd, start** — Steps 8c and 8d unchanged.
6. **Verify from outside AWS**, not from the box:

   ```bash
   curl https://api.yourdomain.com/healthz     # {"ok":true,"scheduler":true}
   ```

   On a DNS-filtered network this can fail while the server is perfectly fine;
   confirm the certificate externally instead (Step 8d).

**What you do *not* touch:** Google Cloud Console (the redirect URI is a
hostname), Vercel (`VITE_SERVER_URL` is a hostname), Supabase, and the Gmail
connection — the refresh token lives in Supabase and still decrypts, given the
same `TOKEN_ENCRYPTION_KEY`.

**Check for a double scheduler.** If the old box is still alive it is still
sending on its own cron, and two schedulers claiming the same rows is the one
genuinely dangerous state here. On the old box:
`sudo systemctl disable --now outreach`, or terminate the instance.

Then confirm exactly one is ticking:

```sql
select max(sent_at) from sends;   -- and watch it advance from one box only
```

---

## Runbook: the domain changed

Read this before deciding: **a tracking origin is one-way once mail is out.**
`sends.body_html_rendered` stores the fully rendered HTML, so every delivered
message carries the old hostname in its pixel and links forever. Nothing you
change later rewrites a message sitting in someone's inbox.

Check what's actually affected before planning anything:

```sql
select
  count(*) filter (where body_html_rendered like '%old-host%') as old_host,
  count(*) filter (where status = 'pending')                   as pending
from sends;
```

`old_host = 0` (nothing sent yet) means you can switch freely and skip step 6.
Otherwise the old hostname has to keep resolving and keep serving.

1. **Two A records on the new domain**, `api` and `track` → `<EIP>`. Host field
   takes the subdomain only. Verify over DNS-over-HTTPS as above.
2. **Add** both new blocks to `/etc/caddy/Caddyfile`, keeping the old ones — one
   `reverse_proxy localhost:8080` block per hostname, blank line between:

   ```
   api.newdomain.com   { reverse_proxy localhost:8080 }
   track.newdomain.com { reverse_proxy localhost:8080 }
   api.olddomain.com   { reverse_proxy localhost:8080 }
   track.olddomain.com { reverse_proxy localhost:8080 }
   ```

   `sudo systemctl reload caddy`, then check `journalctl -u caddy` for
   `certificate obtained successfully` on both new names.
3. **`server/.env`** — two lines, and **leave `TRACKING_HMAC_SECRET` alone** or
   every old click link 400s:

   ```
   GOOGLE_REDIRECT_URI=https://api.newdomain.com/api/auth/google/callback
   TRACKING_BASE_URL=https://track.newdomain.com
   ```
4. **Google Cloud Console** → Credentials → OAuth client → **add** the new
   redirect URI, character for character, keeping the old one until you've
   verified. Google compares the string exactly; a trailing slash is a different
   URI. Do this *before* restarting, or Gmail auth breaks in the gap.
5. **Restart and confirm the value took**:

   ```bash
   sudo systemctl restart outreach
   sudo journalctl -u outreach -n 20 --no-pager | grep tracking
   ```

   The `Server listening` line prints the live `tracking` origin
   (`server/src/index.ts:85`). If it still shows the old host, the build or the
   `.env` didn't reload.
6. **Keep the old domain registered and its DNS pointed here** for as long as old
   mail matters — recipients open months-old threads, and an expired domain turns
   your own tracking links into someone else's traffic. Drop the old Caddy blocks
   and DNS records only once `old_host` above is irrelevant.
7. **Vercel** → `VITE_SERVER_URL=https://api.newdomain.com` → **Redeploy**. The
   redeploy is mandatory; Vite inlines `VITE_` values at build time.
8. **Verify**: Step 11, end to end. Reconnect Gmail deliberately so the new
   callback is exercised, then send yourself a test and check **View original** —
   links must read `https://track.newdomain.com/t/c/…&s=…`. The `&s=` must be
   there; an unsigned link 400s by design rather than becoming an open redirect.

**Never move to a free dynamic-DNS host** — see Step 5 for the three reasons.
And a newly registered domain has no history: put a real site on the apex and let
it age a week or two before running outreach volume through it.

---

## Things that will surprise you later

- **Supabase free plan pauses a project after ~1 week of inactivity.** A paused
  database makes both halves look broken. Unpause from the dashboard. Ironically,
  the scheduler polling every minute keeps it awake.
- **Vercel Hobby is contractually non-commercial.** This tool sends business
  outreach. Worth a deliberate decision rather than a discovery.
- **AWS free tier on a post-July-2025 account closes the account at 6 months.**
  Calendar it now.
- **`TOKEN_ENCRYPTION_KEY`, `TRACKING_HMAC_SECRET` and `TRACKING_BASE_URL` are
  effectively permanent** once you've connected Gmail and sent tracked mail. The
  first two must survive any rebuild; the third is baked into delivered messages.
  Back them up — see [Back this up now](#back-this-up-now-both-runbooks-below-depend-on-it).
- **The EC2 box is disposable; two secrets on it are not.** Everything else lives
  in Supabase, Vercel or git. Rebuilding is mechanical *if* you kept those two.
- **Two schedulers is the one dangerous state.** If an old box is still running
  after a migration, both poll the same `sends` rows. Disable the old service.
- **Open tracking is unreliable by nature** (Apple Mail Privacy Protection
  pre-loads pixels; Gmail proxies everything). Trust clicks and replies.
- **`ubuntu@<EIP>` with a lost `.pem` is unrecoverable.** Back the key up.
- **1 GB of RAM is the tightest constraint on this box.** The swap file from
  Step 8a is what makes `tsc` possible at all; don't remove it, and don't be
  surprised if a future dependency needs the heap raised past 2048.
