import { Database, Mail, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface AppHeaderProps {
  /** Which top-level page is showing ("compose" keeps Database highlighted). */
  active: "database" | "settings" | "compose"
  onNavigate: (view: "database" | "settings") => void
  recipientCount: number
}

/** Dashboard top bar: product mark, page nav, and the settings gear. */
export function AppHeader({ active, onNavigate, recipientCount }: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 border-b bg-background px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 font-semibold text-foreground">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Mail className="size-4" />
          </span>
          Outreach
        </span>

        <nav className="ml-2 flex items-center gap-1">
          <button
            onClick={() => onNavigate("database")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              active === "settings"
                ? "text-muted-foreground hover:text-foreground"
                : "bg-accent/10 text-accent"
            )}
          >
            <Database className="size-4" /> Database
          </button>
        </nav>
      </div>

      <div className="flex items-center gap-3">
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {recipientCount} recipients
        </span>
        <Button
          variant={active === "settings" ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label="Settings"
          onClick={() => onNavigate("settings")}
        >
          <Settings />
        </Button>
      </div>
    </header>
  )
}
