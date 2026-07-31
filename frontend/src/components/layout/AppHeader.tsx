import { Database, FileText, LogOut, Mail, Settings, UserRound } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { UserProfile } from "@/lib/types"

/** Pages reachable from the header nav. */
export type NavView = "database" | "templates"

const NAV: { id: NavView; label: string; icon: typeof Database }[] = [
  { id: "database", label: "Database", icon: Database },
  { id: "templates", label: "Templates", icon: FileText },
]

interface AppHeaderProps {
  /** Which top-level page is showing ("compose" keeps Database highlighted). */
  active: "database" | "templates" | "settings" | "compose"
  onNavigate: (view: NavView | "settings") => void
  /** The logged-in owner shown in the profile menu — not the sending account. */
  profile: UserProfile
  onOpenProfile: () => void
  onLogout: () => void
}

/** First letters of the first and last word, e.g. "Uditya Kumar" → "UK". */
function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ""
  const first = words[0]![0]!
  const last = words.length > 1 ? words[words.length - 1]![0]! : ""
  return (first + last).toUpperCase()
}

/** Dashboard top bar: product mark, page nav, and the profile menu. */
export function AppHeader({
  active,
  onNavigate,
  profile,
  onOpenProfile,
  onLogout,
}: AppHeaderProps) {
  const mark = initials(profile.name)

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
          {NAV.map(({ id, label, icon: Icon }) => {
            // Compose is opened from a Database row, so it keeps Database lit.
            const isActive = id === "database" ? active === "database" || active === "compose" : active === id
            return (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-4" /> {label}
              </button>
            )
          })}
        </nav>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account menu"
          className={cn(
            "rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            // Keep the avatar lit while Settings — reached from this menu — is open.
            active === "settings" && "ring-2 ring-accent/40"
          )}
        >
          <Avatar>
            <AvatarFallback>
              {mark || <UserRound className="size-4" />}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>

        {/* Wider than the trigger, which the default width would clamp it to. */}
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="text-sm font-medium text-foreground">{profile.name}</p>
            <p className="truncate">{profile.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenProfile}>
            <UserRound /> Profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onNavigate("settings")}>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onLogout}>
            <LogOut /> Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
