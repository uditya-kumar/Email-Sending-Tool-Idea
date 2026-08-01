import { db, unwrap } from "../db.ts"
import { stepFromRow } from "../../../shared/mappers.ts"
import type { SequenceStep } from "../../../shared/types.ts"

/**
 * `template_steps` lookups, needed only by `POST /api/test-send`.
 *
 * The editor is shared between the Templates page and the per-lead compose flow,
 * so the browser sends a step id without knowing which of the two tables it came
 * from. Resolving that here keeps the ambiguity out of the route.
 */

export async function findTemplateStep(
  stepId: string,
  userId: string
): Promise<SequenceStep | null> {
  const row = await unwrap(
    "find template step",
    db
      .from("template_steps")
      // !inner + the templates filter is the ownership check: template_steps has
      // no user_id of its own and the secret key ignores RLS.
      .select("*, templates!inner(user_id)")
      .eq("id", stepId)
      .eq("templates.user_id", userId)
      .maybeSingle()
  )

  if (!row) return null

  const { templates: _templates, ...step } = row
  return stepFromRow(step)
}
