#!/usr/bin/env node
/**
 * Regenerate `shared/database.types.ts` from the live Supabase schema.
 *
 *   cd server && npm run db:types
 *
 * Run this after **every** change to `supabase/schema.sql`. A stale
 * `database.types.ts` is worse than none: it type-checks against columns that no
 * longer exist, which is exactly the class of bug the generated types were added
 * to prevent (see TODO.md → *Type safety*).
 *
 * Wrapped in a script rather than left as a raw `npx supabase gen types` line
 * because three things need doing around the command: read the project ref out of
 * `SUPABASE_URL` so it is never duplicated in two places, write to the shared
 * folder rather than the server's, and refuse to overwrite a good file with the
 * error output of a failed run.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, "..")
const repoRoot = resolve(serverDir, "..")
const outputPath = resolve(repoRoot, "shared", "database.types.ts")

const projectRef = readProjectRef()

console.log(`Generating types for project ${projectRef} → shared/database.types.ts`)

/*
 * `--project-id` (the hosted project) rather than `--local`: this repo's schema is
 * applied to the cloud project directly, so the cloud is the source of truth.
 * Requires a logged-in CLI — `npx supabase login` — whose token is a developer
 * credential and deliberately not one of the server's env vars.
 */
const isWindows = process.platform === "win32"

const result = spawnSync(
  isWindows ? "npx.cmd" : "npx",
  ["--yes", "supabase@latest", "gen", "types", "typescript", "--project-id", projectRef],
  {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    /*
     * `shell: true` on Windows only. Node ≥18.20 refuses to spawn a `.cmd` or
     * `.bat` directly — it fails with EINVAL rather than running it — because
     * doing so was the CVE-2024-27980 argument-injection hole. A shell is the
     * supported way to launch one, and the arguments here are a project ref
     * matched against `[a-z0-9]+` plus literals, so there is nothing to inject.
     */
    ...(isWindows ? { shell: true } : {}),
  }
)

if (result.error) {
  fail(`Could not run the Supabase CLI: ${result.error.message}`)
}

if (result.status !== 0) {
  fail(
    `supabase gen types exited with ${result.status}.\n` +
      // Both streams: the CLI reports its own errors as a JSON object on
      // **stdout** and leaves stderr empty, so printing only stderr turns a
      // specific message ("your account does not have the necessary
      // privileges") into a blank line and a guess about logging in.
      `${[result.stdout, result.stderr].map((s) => s?.trim()).filter(Boolean).join("\n")}\n\n` +
      "If this is an auth error, run: npx supabase login"
  )
}

const generated = result.stdout

/*
 * Sanity-check before writing. The CLI prints diagnostics to stdout in some
 * failure modes while still exiting 0, and clobbering a working types file with a
 * warning message would break both packages' builds at once.
 */
if (!generated.includes("export type Database")) {
  fail(
    "The generated output does not contain `export type Database` — refusing to " +
      `overwrite ${outputPath}. Output was:\n${generated.slice(0, 500)}`
  )
}

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:  cd server && npm run db:types
 * Source of truth:  supabase/schema.sql (applied to project ${projectRef})
 *
 * Committed to the repo on purpose, so a build needs no Supabase credentials.
 */

`

writeFileSync(outputPath, header + generated.replace(/^﻿/, ""), "utf8")

console.log(`Wrote ${outputPath}`)
console.log("Now run `npm run typecheck` in both server/ and frontend/.")

/**
 * The project ref, taken from `SUPABASE_URL` in `server/.env`.
 *
 * Parsed out of the URL rather than stored as its own variable so there is one
 * place that identifies the project, and no way for the two to drift apart.
 */
function readProjectRef() {
  const fromEnv = process.env.SUPABASE_PROJECT_ID
  if (fromEnv) return fromEnv

  const envPath = resolve(serverDir, ".env")

  if (!existsSync(envPath)) {
    fail(
      "No server/.env found. Copy server/.env.example to server/.env and fill in " +
        "SUPABASE_URL, or set SUPABASE_PROJECT_ID for this command."
    )
  }

  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("SUPABASE_URL="))

  const url = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")

  if (!url) fail("SUPABASE_URL is not set in server/.env.")

  // https://<ref>.supabase.co → <ref>
  const match = /^https:\/\/([a-z0-9]+)\.supabase\./i.exec(url)

  if (!match?.[1]) {
    fail(
      `Could not read a project ref from SUPABASE_URL="${url}". ` +
        "Expected https://<project-ref>.supabase.co"
    )
  }

  return match[1]
}

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}
