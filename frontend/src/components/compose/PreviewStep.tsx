import { useMemo, useState } from "react"
import { ChevronDown, ChevronUp, Mail, Search, Send, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { renderTags } from "@/lib/merge-tags"
import { formatIST } from "@/lib/time"
import type { Lead, SequenceStep } from "@/lib/types"

/** A label/value row in the profile panel. Shows "—" when empty. */
function ProfileRow({ label, value }: { label: string; value?: string }) {
  return (
    <p className="text-muted-foreground">
      {label}: <span className="text-foreground">{value || "—"}</span>
    </p>
  )
}

interface PreviewStepProps {
  leads: Lead[]
  openingEmail?: SequenceStep
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

/** Step 3 — per-recipient rendered preview with a contact profile panel. */
export function PreviewStep({ leads, openingEmail }: PreviewStepProps) {
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState(leads[0]?.id ?? "")

  const filtered = useMemo(
    () =>
      leads.filter((l) =>
        `${l.contactFullName} ${l.email} ${l.companyName}`
          .toLowerCase()
          .includes(search.toLowerCase())
      ),
    [leads, search]
  )

  const selected = leads.find((l) => l.id === selectedId) ?? filtered[0] ?? leads[0]
  const selectedIndex = leads.findIndex((l) => l.id === selected?.id)

  const subject = selected && openingEmail?.subject
    ? renderTags(openingEmail.subject, selected)
    : ""
  const bodyHtml = selected && openingEmail?.bodyHtml
    ? renderTags(openingEmail.bodyHtml, selected)
    : ""

  function step(delta: number) {
    const next = leads[selectedIndex + delta]
    if (next) setSelectedId(next.id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sub-toolbar */}
      <div className="flex items-center justify-between gap-3 border-b bg-background px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground">
            {leads.length} recipients
          </span>
          <div className="relative w-72">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email address…"
              className="h-9 pl-8"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="personalize" className="gap-1.5 text-sm font-normal text-muted-foreground">
            <Sparkles className="size-4" /> Personalize emails
          </Label>
          <Switch id="personalize" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Recipient list */}
        <div className="w-72 shrink-0 overflow-y-auto border-r bg-background">
          {filtered.map((lead) => (
            <button
              key={lead.id}
              onClick={() => setSelectedId(lead.id)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 border-b px-4 py-3 text-left transition-colors",
                lead.id === selected?.id ? "bg-accent/10" : "hover:bg-muted/50"
              )}
            >
              <span className="text-sm font-medium text-foreground">
                {lead.contactFullName}
              </span>
              <span className="text-xs text-muted-foreground">
                {lead.jobTitle ? `${lead.jobTitle} at ${lead.companyName}` : lead.email}
              </span>
            </button>
          ))}
        </div>

        {/* Rendered email */}
        <div className="flex-1 overflow-y-auto bg-muted/30 p-6">
          <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <Mail className="size-4 text-muted-foreground" />
                {openingEmail?.name ?? "Opening email"}
              </span>
              <Send className="size-4 text-muted-foreground" />
            </div>
            <div className="border-b px-4 py-3 text-sm">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium text-foreground">{subject || "—"}</span>
            </div>
            <div
              className="prose-email px-4 py-4 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_p]:mb-3"
              dangerouslySetInnerHTML={{ __html: bodyHtml || "<p>No content yet.</p>" }}
            />
          </div>
        </div>

        {/* Profile panel */}
        {selected && (
          <div className="w-72 shrink-0 overflow-y-auto border-l bg-background p-5">
            <div className="mb-4 flex items-start justify-between">
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => step(-1)}
                  disabled={selectedIndex <= 0}
                  aria-label="Previous recipient"
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => step(1)}
                  disabled={selectedIndex >= leads.length - 1}
                  aria-label="Next recipient"
                >
                  <ChevronDown />
                </Button>
              </div>
              <Avatar className="size-14 bg-accent/15">
                <AvatarFallback className="bg-accent/15 text-lg font-medium text-accent">
                  {initials(selected.contactFullName)}
                </AvatarFallback>
              </Avatar>
            </div>

            <h3 className="text-lg font-semibold text-foreground">
              {selected.contactFullName}
            </h3>
            <p className="text-sm text-muted-foreground">{selected.email}</p>

            <div className="mt-5 space-y-5 text-sm">
              <div className="space-y-1">
                <p className="font-semibold text-foreground">Profile</p>
                <ProfileRow label="Full name" value={selected.contactFullName} />
                <ProfileRow label="Job title" value={selected.jobTitle} />
              </div>

              <div className="space-y-1">
                <p className="font-semibold text-foreground">Organization</p>
                <ProfileRow label="Company" value={selected.companyName} />
                {selected.website ? (
                  <p className="text-muted-foreground">
                    Website:{" "}
                    <a
                      href={selected.website}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      {selected.website.replace(/^https?:\/\//, "")}
                    </a>
                  </p>
                ) : (
                  <ProfileRow label="Website" value={undefined} />
                )}
              </div>

              <div className="space-y-1">
                <p className="font-semibold text-foreground">Outreach</p>
                <ProfileRow
                  label="Personalization"
                  value={selected.personalizationLine}
                />
                <ProfileRow label="Send time" value={formatIST(selected.sendTimeIST)} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
