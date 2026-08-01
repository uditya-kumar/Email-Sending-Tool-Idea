import { Loader2 } from "lucide-react"
import { useState } from "react"
import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import { LoginPage } from "@/components/auth/LoginPage"
import { AppHeader, type NavView } from "@/components/layout/AppHeader"
import { DatabasePage } from "@/components/database/DatabasePage"
import { ComposeFlow } from "@/components/compose/ComposeFlow"
import { TemplatesPage } from "@/components/templates/TemplatesPage"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { SenderLimitDialog } from "@/components/settings/SenderLimitDialog"
import { ProfileDialog } from "@/components/settings/ProfileDialog"
import { useAuth, signOut } from "@/lib/auth"
import { fullName } from "@/lib/leads"
import {
  DEFAULT_SETTINGS,
  MOCK_LEADS,
  MOCK_SENDERS,
  MOCK_TEMPLATES,
  newSequenceForLead,
} from "@/lib/mock-data"
import { formatIST } from "@/lib/time"
import type {
  AppView,
  EmailTemplate,
  Lead,
  SenderAccount,
  SequenceSettings,
  SequencesByLead,
  UserProfile,
} from "@/lib/types"

/** Seed one sequence per lead so every recipient starts with their own copy. */
function seedSequences(leads: Lead[]): SequencesByLead {
  return Object.fromEntries(leads.map((l) => [l.id, newSequenceForLead(l.id)]))
}

/** Which nav page a view belongs to (compose is reached from Database). */
function navOrigin(view: AppView): NavView {
  return view === "templates" ? "templates" : "database"
}

/**
 * Auth gate. Kept as a separate component from `Workspace` so that every hook
 * below it can assume a session exists — the alternative is threading a
 * `session | null` through the whole tree and null-checking it at each data call.
 * Unmounting on sign-out also discards all in-memory state, which is what stops
 * one account's leads from being visible after switching.
 */
export default function App() {
  const auth = useAuth()

  if (auth.status === "loading") {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        {/* No text: this resolves from localStorage in a few milliseconds, and a
            "Loading…" that flashes once per reload reads as jank. */}
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (auth.status === "signed-out") return <LoginPage />

  return <Workspace initialProfile={auth.profile} />
}

function Workspace({ initialProfile }: { initialProfile: UserProfile }) {
  const [view, setView] = useState<AppView>("database")
  /**
   * The page Settings was opened from, so its Back button returns there instead
   * of always dumping the user on Database.
   */
  const [settingsOrigin, setSettingsOrigin] = useState<NavView>("database")
  /** Which lead's compose flow is open (null on Database/Settings). */
  const [composingId, setComposingId] = useState<string | null>(null)

  const [leads, setLeads] = useState<Lead[]>(MOCK_LEADS)
  const [sequences, setSequences] = useState<SequencesByLead>(() =>
    seedSequences(MOCK_LEADS)
  )
  const [templates, setTemplates] = useState<EmailTemplate[]>(MOCK_TEMPLATES)
  /**
   * Who's logged in. Seeded from the real session rather than mock data, and
   * held in state because the Profile dialog can edit the display name.
   */
  const [profile, setProfile] = useState<UserProfile>(initialProfile)
  const [senders, setSenders] = useState<SenderAccount[]>(MOCK_SENDERS)
  const [settings, setSettings] = useState<SequenceSettings>(DEFAULT_SETTINGS)
  const [editingSenderId, setEditingSenderId] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)

  const composingLead = leads.find((l) => l.id === composingId) ?? null

  /** Open the per-recipient Content → Preview → Launch flow. */
  function openCompose(lead: Lead) {
    // Leads added or imported after mount have no sequence yet — create one.
    setSequences((prev) =>
      prev[lead.id] ? prev : { ...prev, [lead.id]: newSequenceForLead(lead.id) }
    )
    setComposingId(lead.id)
    setView("compose")
  }

  function backToDatabase() {
    setComposingId(null)
    setView("database")
  }

  function patchLead(id: string, patch: Partial<Lead>) {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  /** Pull a scheduled recipient back to draft so they can be edited again. */
  function cancelSchedule(lead: Lead) {
    patchLead(lead.id, { status: "draft" })
    toast.success(`Schedule cancelled for ${fullName(lead) || lead.email}`, {
      description: "They're back to draft — nothing will send until you launch again.",
    })
  }

  function launchLead(lead: Lead) {
    patchLead(lead.id, { status: "scheduled" })
    toast.success(`Scheduled for ${fullName(lead) || lead.email}`, {
      // formatIST already appends "IST" — don't add a second one.
      description: `Sends at ${formatIST(lead.sendTimeIST)} from ${
        senders[0]?.email ?? "your Gmail account"
      }.`,
    })
    backToDatabase()
  }

  const editingSender = senders.find((s) => s.id === editingSenderId) ?? null

  /** Disconnect a sending account — nothing can send without one, so warn. */
  function removeSender(sender: SenderAccount) {
    setSenders((prev) => prev.filter((s) => s.id !== sender.id))
    toast.success(`Disconnected ${sender.email} for sending`, {
      // Only the send path is affected — you're still signed in as yourself.
      description: "Connect an account again before launching any recipients.",
    })
  }

  /**
   * Sign out. No local state to clear on success — `onAuthStateChange` swaps this
   * whole component for the login screen, which discards it.
   */
  async function logout() {
    const message = await signOut()
    if (message) toast.error("Couldn't log out", { description: message })
  }

  return (
    <div className="flex h-svh flex-col bg-background">
      {/* Compose owns its own header (breadcrumb + step tabs). */}
      {view !== "compose" && (
        <AppHeader
          active={view}
          onNavigate={(next) => {
            // Remember where Settings was opened from so Back can return there.
            if (next === "settings") {
              if (view !== "settings") setSettingsOrigin(navOrigin(view))
            } else {
              setSettingsOrigin(next)
            }
            setComposingId(null)
            setView(next)
          }}
          profile={profile}
          onOpenProfile={() => setProfileOpen(true)}
          onLogout={logout}
        />
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Database manages its own scrolling (rows scroll, chrome stays put). */}
        {view === "database" && (
          <DatabasePage
            leads={leads}
            onChange={setLeads}
            onSend={openCompose}
            onCancelSchedule={cancelSchedule}
          />
        )}

        {view === "compose" && composingLead && (
          <ComposeFlow
            key={composingLead.id}
            lead={composingLead}
            steps={sequences[composingLead.id] ?? []}
            onStepsChange={(steps) =>
              setSequences((prev) => ({ ...prev, [composingLead.id]: steps }))
            }
            templates={templates}
            onLeadChange={(patch) => patchLead(composingLead.id, patch)}
            onLaunch={() => launchLead(composingLead)}
            onBack={backToDatabase}
            senderEmail={senders[0]?.email}
          />
        )}

        {view === "templates" && (
          <TemplatesPage
            templates={templates}
            onChange={setTemplates}
            senderEmail={senders[0]?.email}
          />
        )}

        {view === "settings" && (
          <div className="flex-1 overflow-y-auto">
            <SettingsPage
              senders={senders}
              settings={settings}
              onSettingsChange={(patch) =>
                setSettings((prev) => ({ ...prev, ...patch }))
              }
              onEditSender={(s) => setEditingSenderId(s.id)}
              onRemoveSender={removeSender}
              onSaveSchedule={() => toast.success("Settings saved")}
              onBack={() => setView(settingsOrigin)}
              backLabel={settingsOrigin === "templates" ? "Templates" : "Database"}
            />
          </div>
        )}
      </main>

      <SenderLimitDialog
        sender={editingSender}
        onOpenChange={(open) => !open && setEditingSenderId(null)}
        onSave={(dailyLimit) => {
          setSenders((prev) =>
            prev.map((s) => (s.id === editingSenderId ? { ...s, dailyLimit } : s))
          )
          toast.success(`Send limit set to ${dailyLimit}/day`)
        }}
      />

      <ProfileDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        profile={profile}
        sender={senders[0] ?? null}
        onSave={(name) => {
          setProfile((prev) => ({ ...prev, name }))
          toast.success("Profile updated")
        }}
      />

      <Toaster position="bottom-right" />
    </div>
  )
}
