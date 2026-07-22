import { X, ChevronDown, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface WizardHeaderProps {
  sequenceName: string
  savedLabel: string
  /** Label for the primary action (e.g. "Next" or "Launch sequence"). */
  primaryLabel: string
  primaryIsLaunch?: boolean
  onPrimary: () => void
  onClose?: () => void
}

/** Top bar: breadcrumb + sequence name, saved indicator, primary CTA. */
export function WizardHeader({
  sequenceName,
  savedLabel,
  primaryLabel,
  primaryIsLaunch = false,
  onPrimary,
  onClose,
}: WizardHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 border-b bg-background px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X />
        </Button>
        <div className="flex min-w-0 items-center gap-1.5 text-[15px]">
          <span className="text-muted-foreground">Sequences</span>
          <span className="text-muted-foreground">/</span>
          <button className="flex min-w-0 items-center gap-1 font-semibold text-foreground hover:opacity-80">
            <span className="truncate">{sequenceName}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <span className="hidden text-sm text-muted-foreground italic sm:inline">
          {savedLabel}
        </span>
        <Button onClick={onPrimary} className="gap-1.5">
          {primaryLabel}
          {!primaryIsLaunch && <ArrowRight className="size-4" />}
        </Button>
      </div>
    </header>
  )
}
