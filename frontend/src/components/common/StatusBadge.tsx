import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SenderStatus, VerificationStatus } from "@/lib/types"

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

/** Status pill for a connected sender account. */
export function SenderStatusBadge({ status }: { status: SenderStatus }) {
  const map = {
    active: { label: "Active", cls: "bg-success/10 text-success", Icon: CheckCircle2 },
    needs_protection: {
      label: "Needs protection",
      cls: "bg-warning/15 text-warning-foreground",
      Icon: AlertTriangle,
    },
    disconnected: { label: "Disconnected", cls: "bg-destructive/10 text-destructive", Icon: XCircle },
  } as const
  const { label, cls, Icon } = map[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        cls
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  )
}
