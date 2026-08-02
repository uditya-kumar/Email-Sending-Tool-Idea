# Deploying the backend (AWS EC2) — step by step

Follow this top to bottom. The frontend is already live on Vercel
(`outreach-tool-teal.vercel.app`); this guide gets the Express server onto AWS,
gives it HTTPS, and connects the two.

Estimated time: **2–3 hours** the first time, most of it waiting on DNS and
Google's consent screen.

---

## Read this first: three things that will bite you

**1. Your backend must be HTTPS, not HTTP.** The frontend is on `https://`.
Browsers block `https://` pages from calling `http://` APIs (mixed content) — no
error you can fix in code, the request simply never leaves. So plain
`http://<ec2-ip>:8080` will not work, and Steps 6–8 exist entirely to solve this.

**2. You cannot get a certificate for an AWS hostname.** Let's Encrypt
permanently refuses `*.compute.amazonaws.com` — those names change hands, so
issuing for them is forbidden by policy. You need a domain name you control.
Step 5 uses DuckDNS (free) if you don't have one.

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

**If you already own a domain**, create an A record pointing a subdomain
(e.g. `api.yourdomain.com`) at `<EIP>`, then skip to Step 6 using that name.

**Otherwise use DuckDNS** — free, works with Let's Encrypt:

1. Go to <https://www.duckdns.org>, sign in with Google/GitHub.
2. Under **domains**, type a name (e.g. `uditya-outreach`) → **add domain**.
   You now own `uditya-outreach.duckdns.org`.
3. Put `<EIP>` in the **current ip** box → **update ip**.
4. Copy your **token** from the top of the page.

Verify DNS resolves before continuing — from your EC2 SSH session:

```bash
dig +short uditya-outreach.duckdns.org
```

It must print `<EIP>`. If it prints nothing, wait a minute and retry. **Do not
proceed until this works** — the certificate request in Step 6 will fail.

Because your IP is now static (Elastic IP), you don't need the DuckDNS updater
cron that most tutorials add.

From here on, `<DOMAIN>` means the name you chose.

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

TRACKING_BASE_URL=https://<DOMAIN>
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
- **`TRACKING_BASE_URL`** — the origin baked into every pixel and click link.
  Once emails are sent with it, changing it breaks tracking on those messages.
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

Replace the whole file with:

```
<DOMAIN> {
	reverse_proxy localhost:8080
}
```

That's genuinely all — Caddy fetches the certificate on first start and renews it
forever.

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

Then from **your own machine**, not the EC2 box:

```bash
curl https://<DOMAIN>/healthz
```

The same `{"ok":true,"scheduler":true}` over `https://` with no certificate
warning means Steps 2–8 are done. If it fails, check `sudo journalctl -u caddy -n 50 --no-pager` — the
usual cause is DNS not yet pointing at `<EIP>`, or port 80 not open to `0.0.0.0/0`.

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

## Things that will surprise you later

- **Supabase free plan pauses a project after ~1 week of inactivity.** A paused
  database makes both halves look broken. Unpause from the dashboard. Ironically,
  the scheduler polling every minute keeps it awake.
- **Vercel Hobby is contractually non-commercial.** This tool sends business
  outreach. Worth a deliberate decision rather than a discovery.
- **AWS free tier on a post-July-2025 account closes the account at 6 months.**
  Calendar it now.
- **`TOKEN_ENCRYPTION_KEY` and `TRACKING_BASE_URL` are effectively permanent**
  once you've connected Gmail and sent tracked mail.
- **Open tracking is unreliable by nature** (Apple Mail Privacy Protection
  pre-loads pixels; Gmail proxies everything). Trust clicks and replies.
- **`ubuntu@<EIP>` with a lost `.pem` is unrecoverable.** Back the key up.
- **1 GB of RAM is the tightest constraint on this box.** The swap file from
  Step 8a is what makes `tsc` possible at all; don't remove it, and don't be
  surprised if a future dependency needs the heap raised past 2048.
