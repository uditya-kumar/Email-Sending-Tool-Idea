import { useState } from "react"
import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import { AppHeader, type NavView } from "@/components/layout/AppHeader"
import { DatabasePage } from "@/components/database/DatabasePage"
import { ComposeFlow } from "@/components/compose/ComposeFlow"
import { TemplatesPage } from "@/components/templates/TemplatesPage"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { SenderPanel } from "@/components/settings/SenderPanel"
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
} from "@/lib/types"

/** Seed one sequence per lead so every recipient starts with their own copy. */
function seedSequences(leads: Lead[]): SequencesByLead {
  return Object.fromEntries(leads.map((l) => [l.id, newSequenceForLead(l.id)]))
}

/** Which nav page a view belongs to (compose is reached from Database). */
function navOrigin(view: AppView): NavView {
  return view === "templates" ? "templates" : "database"
}

export default function App() {
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
  const [senders, setSenders] = useState<SenderAccount[]>(MOCK_SENDERS)
  const [settings, setSettings] = useState<SequenceSettings>(DEFAULT_SETTINGS)
  const [editingSenderId, setEditingSenderId] = useState<string | null>(null)

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

  function launchLead(lead: Lead) {
    patchLead(lead.id, { status: "scheduled" })
    toast.success(`Scheduled for ${lead.contactFullName || lead.email}`, {
      description: `Sends at ${formatIST(lead.sendTimeIST)} IST from ${
        senders[0]?.email ?? "your Gmail account"
      }.`,
    })
    backToDatabase()
  }

  const editingSender = senders.find((s) => s.id === editingSenderId) ?? null
  const scheduledCount = leads.filter((l) => l.status !== "draft").length

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
          recipientCount={leads.length}
        />
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Database manages its own scrolling (rows scroll, chrome stays put). */}
        {view === "database" && (
          <DatabasePage leads={leads} onChange={setLeads} onSend={openCompose} />
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
          />
        )}

        {view === "templates" && (
          <TemplatesPage templates={templates} onChange={setTemplates} />
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
              onSaveSchedule={() => toast.success("Settings saved")}
              onBack={() => setView(settingsOrigin)}
              backLabel={settingsOrigin === "templates" ? "Templates" : "Database"}
            />
          </div>
        )}
      </main>

      <SenderPanel
        sender={editingSender}
        onOpenChange={(open) => !open && setEditingSenderId(null)}
        onUpdate={(patch) =>
          setSenders((prev) =>
            prev.map((s) => (s.id === editingSenderId ? { ...s, ...patch } : s))
          )
        }
        recipientsAllocated={leads.length}
        emailsScheduled={scheduledCount}
      />

      <Toaster position="bottom-right" />
    </div>
  )
}
