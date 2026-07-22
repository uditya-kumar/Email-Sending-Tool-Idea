import { CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WizardTab } from "@/lib/types"

interface TabDef {
  id: WizardTab
  label: string
  /** Whether the step is "complete" (shows a checkmark instead of a number). */
  complete: boolean
}

interface WizardTabsProps {
  active: WizardTab
  onChange: (tab: WizardTab) => void
  completed: Record<WizardTab, boolean>
}

const ORDER: WizardTab[] = ["audience", "content", "preview", "settings"]
const LABELS: Record<WizardTab, string> = {
  audience: "Audience",
  content: "Content",
  preview: "Preview",
  settings: "Settings",
}

/** Step tabs: circled checkmark (or number) + blue underline on the active tab. */
export function WizardTabs({ active, onChange, completed }: WizardTabsProps) {
  const tabs: TabDef[] = ORDER.map((id) => ({
    id,
    label: LABELS[id],
    complete: completed[id],
  }))

  return (
    <nav className="flex items-center gap-6 border-b bg-background px-6">
      {tabs.map((tab, i) => {
        const isActive = tab.id === active
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex items-center gap-2 border-b-2 py-3 text-[15px] font-medium transition-colors",
              isActive
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.complete ? (
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
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}
