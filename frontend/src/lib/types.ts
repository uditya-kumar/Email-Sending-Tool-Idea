/**
 * Re-export only. The real definitions live in `shared/types.ts` so the Express
 * server type-checks against exactly the same domain vocabulary the UI does.
 * Kept as a shim so no component import has to change.
 */
export * from "@shared/types.ts"
