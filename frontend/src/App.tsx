import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
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
import { setDailyLimit, useSenders } from "@/lib/accounts"
import { ApiError, disconnectAccount, googleConsentUrl } from "@/lib/api"
import { consumeOAuthReturn } from "@/lib/oauth-return"
import { fullName } from "@/lib/leads"
import {
  DEFAULT_SETTINGS,
  MOCK_LEADS,
  newSequenceForLead,
} from "@/lib/mock-data"
import { formatIST } from "@/lib/time"
import { useTemplates } from "@/lib/use-templates"
import type {
  AppView,
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
 * The result of the Google OAuth round trip, read once at module load.
 *
 * Deliberately not inside a component. The server redirects to
 * `/settings?connected=1&email=…` and this app has no router, so the query string
 * is the only record of what happened — and reading it *consumes* it (the URL is
 * cleaned so a reload doesn't re-announce the same connect). That makes it a
 * once-per-page-load fact, which is exactly what module scope expresses: a
 * `useState` initializer or an effect would run twice under StrictMode's
 * double-invoke and the second read would find nothing.
 */
const OAUTH_RETURN = consumeOAuthReturn()

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
  // Returning from Google lands on Settings, where the account list is.
  const [view, setView] = useState<AppView>(OAUTH_RETURN ? "settings" : "database")
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
  /**
   * Who's logged in. Seeded from the real session rather than mock data, and
   * held in state because the Profile dialog can edit the display name.
   */
  const [profile, setProfile] = useState<UserProfile>(initialProfile)
  const [settings, setSettings] = useState<SequenceSettings>(DEFAULT_SETTINGS)
  const [editingSenderId, setEditingSenderId] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  /** True from the Connect click until the browser leaves for Google. */
  const [connecting, setConnecting] = useState(false)

  /** The connected Gmail, read from `gmail_accounts_public` under RLS. */
  const { senders, refresh: refreshSenders } = useSenders()

  const templateStore = useTemplates((message) =>
    toast.error("Couldn't save the template", { description: message })
  )
  const templates = templateStore.templates

  /**
   * Announce the outcome of the OAuth round trip.
   *
   * Only the side effects live here — which page to show is already decided by
   * `view`'s initial value, because that's derived state rather than something to
   * synchronise. A toast can't be rendered from a state initializer, and the
   * just-written account row needs a refetch, so those two things need an effect.
   */
  useEffect(() => {
    if (!OAUTH_RETURN) return

    if (OAUTH_RETURN.kind === "error") {
      toast.error("Couldn't connect your Gmail account", {
        description: OAUTH_RETURN.message,
      })
      return
    }

    toast.success(
      OAUTH_RETURN.email
        ? `Connected ${OAUTH_RETURN.email}`
        : "Gmail account connected",
      { description: "You can send from this account now." }
    )
    /*
     * The server inserted the row while this page was still loading, so the
     * `useSenders` read that ran on mount may have raced it. One extra fetch on
     * the one page load that follows a connect.
     */
    void refreshSenders()
  }, [refreshSenders])

  /** Hand the browser to Google's consent screen. */
  async function connectGmail() {
    setConnecting(true)

    try {
      // A full navigation, not a fetch: the server answers with a 302 to Google
      // and the user has to see and interact with that page.
      window.location.href = await googleConsentUrl()
    } catch (error) {
      setConnecting(false)
      toast.error("Couldn't start the Google connection", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    }
  }

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

  /** Disconnect a sending account — nothing can send without one, so say so. */
  async function removeSender(sender: SenderAccount) {
    try {
      await disconnectAccount(sender.id)
      await refreshSenders()
      toast.success(`Disconnected ${sender.email} for sending`, {
        // Only the send path is affected — you're still signed in as yourself.
        description: "Connect an account again before launching any recipients.",
      })
    } catch (error) {
      toast.error("Couldn't disconnect the account", {
        description:
          error instanceof ApiError || error instanceof Error
            ? error.message
            : "Please try again.",
      })
    }
  }

  /**
   * The daily cap, written through the `set_daily_limit` function — the browser
   * has no UPDATE privilege on `gmail_accounts`, and this is the only field of it
   * the UI may change.
   */
  async function saveDailyLimit(dailyLimit: number) {
    if (!editingSenderId) return

    const message = await setDailyLimit(editingSenderId, dailyLimit)

    if (message) {
      toast.error("Couldn't change the send limit", { description: message })
      return
    }

    await refreshSenders()
    toast.success(`Send limit set to ${dailyLimit}/day`)
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
          <TemplatesPage store={templateStore} senderEmail={senders[0]?.email} />
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
              onRemoveSender={(s) => void removeSender(s)}
              onSaveSchedule={() => toast.success("Settings saved")}
              onConnect={() => void connectGmail()}
              connecting={connecting}
              onBack={() => setView(settingsOrigin)}
              backLabel={settingsOrigin === "templates" ? "Templates" : "Database"}
            />
          </div>
        )}
      </main>

      <SenderLimitDialog
        sender={editingSender}
        onOpenChange={(open) => !open && setEditingSenderId(null)}
        onSave={(dailyLimit) => void saveDailyLimit(dailyLimit)}
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
