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
import {
  ApiError,
  cancelLead,
  disconnectAccount,
  googleConsentUrl,
  launchLead as launchLeadRequest,
} from "@/lib/api"
import { consumeOAuthReturn } from "@/lib/oauth-return"
import { fullName } from "@/lib/leads"
import { newSequenceForLead } from "@/lib/sequence"
import { useLeads } from "@/lib/use-leads"
import { useSequences } from "@/lib/use-sequences"
import { useSettings } from "@/lib/settings"
import { formatIST } from "@/lib/time"
import { useTemplates } from "@/lib/use-templates"
import type { AppView, Lead, SenderAccount, UserProfile } from "@/lib/types"

/** Which nav page a view belongs to (compose is reached from Database). */
function navOrigin(view: AppView): NavView {
  return view === "templates" ? "templates" : "database"
}

/**
 * The server's message, verbatim where there is one.
 *
 * Every 409 from the launch and cancel paths is written to be read by the user
 * ("The opening email has no subject.", "Connect a Gmail account in Settings
 * first.") and carries a stable `code`. Rewording them here would only make them
 * vaguer.
 */
function describeApiError(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return "Please try again."
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

  /**
   * Who's logged in. Seeded from the real session rather than mock data, and
   * held in state because the Profile dialog can edit the display name.
   */
  const [profile, setProfile] = useState<UserProfile>(initialProfile)
  const [editingSenderId, setEditingSenderId] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  /** True from the Connect click until the browser leaves for Google. */
  const [connecting, setConnecting] = useState(false)
  /** True from the Save click on Settings until the write resolves. */
  const [savingSettings, setSavingSettings] = useState(false)

  /**
   * The one `settings` row. Edited locally, written on the Save button rather than
   * debounced — these values gate every future send.
   */
  const settingsStore = useSettings()

  /** The recipient database, read from `leads` under RLS. */
  const leadsStore = useLeads((message) =>
    toast.error("Couldn't save that change", { description: message })
  )
  const leads = leadsStore.leads

  /** Per-recipient sequences, read from `sequence_steps` under RLS. */
  const sequencesStore = useSequences((message) =>
    toast.error("Couldn't save the sequence", { description: message })
  )
  const sequences = sequencesStore.sequences

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

  /*
   * A failed settings *read* is worth saying out loud: the page falls back to the
   * column defaults, which look like real values, so silence here would show a
   * plausible-but-wrong weekday set. Keyed on the message so it toasts once.
   */
  const settingsError = settingsStore.error
  useEffect(() => {
    if (settingsError) {
      toast.error("Couldn't load your settings", { description: settingsError })
    }
  }, [settingsError])

  /*
   * A failed leads read is the one that most needs saying: an empty table is
   * indistinguishable from "you have no recipients", and the natural response to
   * that is to import the CSV again.
   */
  const leadsError = leadsStore.error
  useEffect(() => {
    if (leadsError) {
      toast.error("Couldn't load your recipients", { description: leadsError })
    }
  }, [leadsError])

  /*
   * A failed sequences read has to be loud too: compose would show an empty
   * sequence, `openCompose` would treat that as "this lead has none" and write a
   * fresh one over the top — turning a read failure into lost email content.
   */
  const sequencesError = sequencesStore.error
  useEffect(() => {
    if (sequencesError) {
      toast.error("Couldn't load your sequences", { description: sequencesError })
    }
  }, [sequencesError])

  /** Persist the tracking + weekday settings. */
  async function saveSettings() {
    setSavingSettings(true)
    const message = await settingsStore.save()
    setSavingSettings(false)

    if (message) {
      toast.error("Couldn't save settings", { description: message })
      return
    }

    toast.success("Settings saved")
  }

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

  /**
   * Open the per-recipient Content → Preview → Launch flow.
   *
   * A lead with no sequence gets one created *in the database* now, rather than
   * only in state. Launch re-reads `sequence_steps` server-side and 409s with
   * `no_sequence` on an empty result, so an in-memory-only sequence would look
   * complete on screen and refuse to launch. Navigation isn't awaited — the flow
   * opens immediately and the rows land behind it.
   */
  function openCompose(lead: Lead) {
    /*
     * Guarded on the read having succeeded. If `sequence_steps` failed to load,
     * every lead looks like it has no sequence — and seeding one here would write a
     * blank opening email over content that exists in the database. Better to open
     * an empty flow behind the error toast than to destroy the email.
     */
    if (!sequences[lead.id] && !sequencesStore.loading && !sequencesStore.error) {
      void sequencesStore.setSteps(lead.id, newSequenceForLead(lead.id))
    }
    setComposingId(lead.id)
    setView("compose")
  }

  function backToDatabase() {
    setComposingId(null)
    setView("database")
  }

  /**
   * Cancel a recipient's pending sends.
   *
   * The resulting status comes from the server rather than being assumed to be
   * `draft`: a lead whose opening email is already delivered comes back `sent`, and
   * showing it as a draft would invite a relaunch that the idempotency index then
   * silently refuses.
   */
  async function cancelSchedule(lead: Lead) {
    const who = fullName(lead) || lead.email

    try {
      const result = await cancelLead(lead.id)
      leadsStore.adoptStatus(lead.id, result.status)

      toast.success(`Schedule cancelled for ${who}`, {
        description:
          result.status === "sent"
            ? `${result.cancelled} pending follow-up${
                result.cancelled === 1 ? "" : "s"
              } cancelled. The emails already sent can't be recalled.`
            : "They're back to draft — nothing will send until you launch again.",
      })
    } catch (error) {
      toast.error(`Couldn't cancel ${who}`, { description: describeApiError(error) })
    }
  }

  /**
   * Queue a recipient's opening email.
   *
   * Content is flushed first: the server renders the row it reads from
   * `sequence_steps`, so an unflushed edit would be missing from the email that
   * actually goes out. Everything the server can refuse — no sequence, empty
   * subject or body, no connected account, already replied — comes back as a 409
   * with a message written to be shown as-is, which is why the failure path doesn't
   * reword it. The flow stays open on failure so it can be fixed.
   */
  async function launchLead(lead: Lead) {
    const who = fullName(lead) || lead.email

    await sequencesStore.flush()

    try {
      const result = await launchLeadRequest(lead.id)
      leadsStore.adoptStatus(lead.id, "scheduled")

      if (result.alreadyQueued) {
        toast.info(`${who} was already scheduled`, {
          description: `Sending at ${formatIST(lead.sendTimeIST)} — nothing new was queued.`,
        })
      } else {
        toast.success(`Scheduled for ${who}`, {
          // formatIST already appends "IST" — don't add a second one.
          description: `Sends at ${formatIST(lead.sendTimeIST)} from ${
            result.from ?? senders[0]?.email ?? "your Gmail account"
          }.`,
        })
      }

      backToDatabase()
    } catch (error) {
      toast.error(`Couldn't launch ${who}`, { description: describeApiError(error) })
    }
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
            store={leadsStore}
            onSend={openCompose}
            onCancelSchedule={(lead) => void cancelSchedule(lead)}
            onLeadDeleted={sequencesStore.forget}
          />
        )}

        {view === "compose" && composingLead && (
          <ComposeFlow
            key={composingLead.id}
            lead={composingLead}
            steps={sequences[composingLead.id] ?? []}
            onStepsChange={(steps) =>
              sequencesStore.setSteps(composingLead.id, steps)
            }
            onEditStep={(stepId, patch) =>
              sequencesStore.editStep(composingLead.id, stepId, patch)
            }
            onApplyTemplate={(template) =>
              sequencesStore.applyTemplate(composingLead.id, template)
            }
            templates={templates}
            onChangeSendTime={(hhmm) => leadsStore.setSendTime(composingLead.id, hhmm)}
            onAttach={(stepId, file) =>
              sequencesStore.attach(composingLead.id, stepId, file)
            }
            onDetach={(stepId, attachment) =>
              sequencesStore.detach(composingLead.id, stepId, attachment)
            }
            onLaunch={() => launchLead(composingLead)}
            onBack={backToDatabase}
            onFlush={sequencesStore.flush}
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
              settings={settingsStore.settings}
              onSettingsChange={settingsStore.patch}
              onEditSender={(s) => setEditingSenderId(s.id)}
              onRemoveSender={(s) => void removeSender(s)}
              onSaveSchedule={() => void saveSettings()}
              settingsLoading={settingsStore.loading}
              settingsDirty={settingsStore.dirty}
              savingSettings={savingSettings}
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
