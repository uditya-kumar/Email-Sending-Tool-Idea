# Initial Setup

Run these commands to get a basic project skeleton with all packages installed **before Claude
takes over** to write the actual code. This creates two projects — `frontend/` and `server/` — inside
this folder.

> Prereqs: **Node.js 20+** and **npm** installed. Check with `node -v` and `npm -v`.
> Shell: these are written for Git Bash (your default). Run from the project root:
> `C:/Users/udity/Desktop/Email Sending Tool Idea`

---

## 1. Frontend — React + Vite + TypeScript

```bash
# From the project root
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

### 1a. Tailwind CSS (v4 + Vite plugin)

```bash
npm install tailwindcss @tailwindcss/vite
```

Then add `@import "tailwindcss";` at the top of `src/index.css`, and add the plugin to
`vite.config.ts` (Claude will wire the config + the `@/` path alias for shadcn).

### 1b. Core frontend libraries

```bash
npm install @supabase/supabase-js @tanstack/react-table papaparse handlebars luxon
npm install -D @types/papaparse @types/luxon
```

### 1c. Tiptap (rich-text template editor)

```bash
npm install @tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-link @tiptap/extension-placeholder
```

### 1d. shadcn/ui

```bash
# Still inside frontend/. Requires the @/ path alias in tsconfig + vite.config (Claude sets these up).
npx shadcn@latest init
# Then a starter set of components:
npx shadcn@latest add button input table dialog dropdown-menu select textarea label card tabs badge sonner
```

```bash
cd ..
```

---

## 2. Backend — Express + TypeScript

```bash
# From the project root
mkdir server
cd server
npm init -y
```

### 2a. Runtime dependencies

```bash
npm install express cors googleapis @supabase/supabase-js node-cron luxon dotenv
```

### 2b. Dev dependencies (TypeScript + live reload)

```bash
npm install -D typescript tsx @types/node @types/express @types/cors @types/node-cron
npx tsc --init
```

```bash
cd ..
```

---

## 3. Accounts & credentials to create (do these in parallel)

You don't need to code anything here — just create the accounts and paste the keys into `.env`
files (Claude will provide `.env.example` templates).

### 3a. Supabase project
1. Create a project at https://supabase.com (free tier).
2. From **Project Settings → API keys**, copy:
   - `Project URL`
   - **Publishable key** (`sb_publishable_...`) — for the frontend (replaces the old anon key)
   - **Secret key** (`sb_secret_...`) — for the Express server, **keep secret** (replaces the old service_role key)

### 3b. Google Cloud OAuth (Gmail API)
1. Go to https://console.cloud.google.com → create a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → add your Gmail as a **Test user**.
4. **Credentials → Create Credentials → OAuth client ID → Web application**.
   - Add an authorized redirect URI (e.g. `http://localhost:3000/auth/google/callback`).
   - Copy the **Client ID** and **Client Secret** (server only — **keep secret**).

---

## 4. Environment files (create empty, Claude fills the values in)

```bash
# From the project root
touch frontend/.env.local
touch server/.env
```

`frontend/.env.local` will hold (public, safe for browser):
```
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

`server/.env` will hold (secret, server only):
```
SUPABASE_URL=
SUPABASE_SECRET_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
DAILY_SEND_CAP=30
PORT=3000
```

---

## 5. Verify the skeleton runs

```bash
# Frontend dev server (should open on http://localhost:5173)
cd frontend && npm run dev
```

```bash
# Backend — no start script yet; Claude will add one. For now just confirm deps installed:
cd server && npm ls express googleapis
```

---

## ✅ When this is done
Tell Claude: **"setup done"** — and share your Supabase URL/keys and Google OAuth client
ID/secret (paste into the `.env` files above). Claude will then scaffold the schema, RLS policies,
the lead table UI, Tiptap template editor, tracking endpoints, Gmail send, and the scheduler.
