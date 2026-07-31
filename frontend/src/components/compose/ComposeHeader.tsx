import { ArrowLeft, ArrowRight, CheckCircle2, Rocket } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ComposeStep, Lead } from "@/lib/types"

const ORDER: ComposeStep[] = ["content", "preview"]
const LABELS: Record<ComposeStep, string> = {
  content: "Content",
  preview: "Preview",
}

interface ComposeHeaderProps {
  lead: Lead
  step: ComposeStep
  onStepChange: (step: ComposeStep) => void
  onBack: () => void
  /** Whether the recipient's opening email has content yet. */
  contentReady: boolean
}

/**
 * Header for the per-recipient compose flow: back to Database, whose email this
 * is, and the two-step Content → Preview switcher. Launch lives on Preview only.
 */
export function ComposeHeader({
  lead,
  step,
  onStepChange,
  onBack,
  contentReady,
}: ComposeHeaderProps) {
  const isPreview = step === "preview"

  return (
    <header className="border-b bg-background">
      <div className="flex items-center justify-between gap-4 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to database">
            <ArrowLeft />
          </Button>
          <div className="flex min-w-0 items-center gap-1.5 text-[15px]">
            <button
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground"
            >
              Database
            </button>
            <span className="text-muted-foreground">/</span>
            <span className="truncate font-semibold text-foreground">
              {lead.contactFullName || lead.email}
            </span>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              · {lead.email}
            </span>
          </div>
        </div>

        {!isPreview && (
          <Button className="gap-1.5" onClick={() => onStepChange("preview")}>
            Next <ArrowRight className="size-4" />
          </Button>
        )}
      </div>

      {/* Step switcher */}
      <nav className="flex items-center gap-6 px-6">
        {ORDER.map((id, i) => {
          const isActive = id === step
          const complete = id === "content" ? contentReady : false
          return (
            <button
              key={id}
              onClick={() => onStepChange(id)}
              className={cn(
                "flex items-center gap-2 border-b-2 py-2.5 text-[15px] font-medium transition-colors",
                isActive
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {complete ? (
                <CheckCircle2 className="size-4 text-accent" />
              ) : (
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full text-[11px]",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {i + 1}
                </span>
              )}
              {LABELS[id]}
            </button>
          )
        })}
        {isPreview && (
          <span className="ml-auto flex items-center gap-1.5 py-1.5 text-xs text-muted-foreground">
            <Rocket className="size-3.5" /> Launch this recipient below
          </span>
        )}
      </nav>
    </header>
  )
}
