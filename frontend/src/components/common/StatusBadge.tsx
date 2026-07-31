import { CheckCircle2, Clock, FileEdit, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { LeadStatus, VerificationStatus } from "@/lib/types"

/** Where a single recipient's sequence stands (draft → scheduled → sent). */
export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const map = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground", Icon: FileEdit },
    scheduled: { label: "Scheduled", cls: "bg-accent/10 text-accent", Icon: Clock },
    sent: { label: "Sent", cls: "bg-success/10 text-success", Icon: CheckCircle2 },
  } as const
  const { label, cls, Icon } = map[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        cls
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  )
}

/** Verification badge for a lead's email address. */
export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const map = {
    verified: { label: "Verified", cls: "bg-success/10 text-success", Icon: CheckCircle2 },
    not_verified: { label: "Not verified", cls: "bg-muted text-muted-foreground", Icon: null },
    invalid: { label: "Invalid", cls: "bg-destructive/10 text-destructive", Icon: XCircle },
  } as const
  const { label, cls, Icon } = map[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        cls
      )}
    >
      {Icon && <Icon className="size-3" />}
      {label}
    </span>
  )
}
