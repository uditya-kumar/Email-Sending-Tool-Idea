/**
 * Re-export only — see `shared/merge-tags.ts`.
 *
 * The renderer is shared with the server on purpose: the Preview step and the
 * email that actually goes out must be produced by the same code, or previews
 * lie.
 */
export * from "@shared/merge-tags.ts"
