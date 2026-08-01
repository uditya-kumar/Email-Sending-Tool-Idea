import { Clock, Loader2, Mail, Paperclip, Rocket } from "lucide-react"
import { formatAttachmentSize } from "@shared/attachments.ts"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { fullName } from "@/lib/leads"
import { renderTags } from "@/lib/merge-tags"
import { formatIST } from "@/lib/time"
import { LeadStatusBadge } from "@/components/common/StatusBadge"
import type { Lead, SequenceStep } from "@/lib/types"

/** A label/value row in the profile panel. Shows "—" when empty. */
function ProfileRow({
  label,
  value,
  /** Keep the value's own line breaks (the personalization line can be multiline). */
  multiline,
}: {
  label: string
  value?: string | undefined
  multiline?: boolean | undefined
}) {
  return (
    <p className="text-muted-foreground">
      {label}:{" "}
      <span
        className={cn("text-foreground", multiline && "whitespace-pre-line")}
      >
        {value || "—"}
      </span>
    </p>
  )
}

interface PreviewStepProps {
  lead: Lead
  /** This recipient's own sequence (emails + waits). */
  steps: SequenceStep[]
  onLaunch: () => void
  /** True while the launch request is in flight — this one sends real email. */
  launching?: boolean | undefined
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

/**
 * Compose step 2 — the fully rendered emails for ONE recipient, plus the Launch
 * button. Launch lives only here, so nothing goes out unpreviewed.
 */
export function PreviewStep({ lead, steps, onLaunch, launching }: PreviewStepProps) {
  const emails = steps.filter((s) => s.kind === "email")
  const written = emails.filter((s) => s.subject || s.bodyHtml)
  const canLaunch = written.length > 0

  // Drop a trailing wait — there's no follow-up after it to introduce.
  const lastEmailIdx = steps.reduce(
    (last, s, i) => (s.kind === "email" ? i : last),
    -1
  )
  const visible = steps.filter((_, i) => i <= lastEmailIdx)

  return (
    <div className="flex min-h-0 flex-1">
      {/* Rendered emails */}
      <div className="flex-1 overflow-y-auto bg-muted/30 p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {emails.length ? (
            visible.map((step) =>
              step.kind === "delay" ? (
                <WaitDivider key={step.id} days={step.waitDays ?? 3} />
              ) : (
                <RenderedEmail key={step.id} step={step} lead={lead} />
              )
            )
          ) : (
            <div className="rounded-xl border border-dashed bg-card p-10 text-center text-muted-foreground">
              No emails in this sequence yet. Add a step on the Content tab.
            </div>
          )}
        </div>
      </div>

      {/* Recipient panel + Launch */}
      <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-l bg-background">
        <div className="flex-1 p-5">
          <div className="flex items-center gap-3">
            <Avatar className="size-12 bg-accent/15">
              <AvatarFallback className="bg-accent/15 font-medium text-accent">
                {initials(fullName(lead) || lead.email)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h3 className="truncate font-semibold text-foreground">
                {fullName(lead) || "—"}
              </h3>
              <p className="truncate text-sm text-muted-foreground">{lead.email}</p>
            </div>
          </div>

          <div className="mt-3">
            <LeadStatusBadge status={lead.status} />
          </div>

          <div className="mt-5 space-y-5 text-sm">
            <div className="space-y-1">
              <p className="font-semibold text-foreground">Profile</p>
              <ProfileRow label="First name" value={lead.firstName} />
              <ProfileRow label="Last name" value={lead.lastName} />
              <ProfileRow label="Job title" value={lead.jobTitle} />
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-foreground">Organization</p>
              <ProfileRow label="Company" value={lead.companyName} />
              {lead.website ? (
                <p className="text-muted-foreground">
                  Website:{" "}
                  <a
                    href={lead.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    {lead.website.replace(/^https?:\/\//, "")}
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
                value={lead.personalizationLine}
                multiline
              />
              <ProfileRow label="Send time" value={formatIST(lead.sendTimeIST)} />
              <p className="text-muted-foreground">
                Emails ready:{" "}
                <span className="text-foreground">
                  {written.length} of {emails.length}
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Launch — the only place a send can be started. */}
        <div className="sticky bottom-0 border-t bg-background p-4">
          {/* Disabled while in flight: this queues a real email, and a second
              click would ask the server to launch the same lead twice. It answers
              idempotently, but the toast would still read as a fresh send. */}
          <Button
            className="w-full gap-1.5"
            size="lg"
            disabled={!canLaunch || launching}
            onClick={onLaunch}
          >
            {launching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Rocket className="size-4" />
            )}
            {launching
              ? "Launching…"
              : lead.status === "draft"
                ? "Launch"
                : "Reschedule"}
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {canLaunch
              ? `Sends at ${formatIST(lead.sendTimeIST)} to ${lead.email}`
              : "Add email content before launching."}
          </p>
        </div>
      </div>
    </div>
  )
}

/** One rendered email card with merge tags resolved for this lead. */
function RenderedEmail({ step, lead }: { step: SequenceStep; lead: Lead }) {
  const subject = step.subject ? renderTags(step.subject, lead) : ""
  // The body is injected as HTML, so values need escaping + <br> for newlines.
  const bodyHtml = step.bodyHtml ? renderTags(step.bodyHtml, lead, { html: true }) : ""
  const isEmpty = !step.subject && !step.bodyHtml

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm",
        isEmpty && "border-dashed opacity-70 shadow-none"
      )}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <Mail className="size-4 text-muted-foreground" />
          {step.name}
        </span>
        {isEmpty ? (
          <Badge variant="secondary" className="text-muted-foreground">
            Not written — won't send
          </Badge>
        ) : (
          <Badge variant="secondary">To: {lead.email}</Badge>
        )}
      </div>
      <div className="border-b px-4 py-3 text-sm">
        <span className="text-muted-foreground">Subject: </span>
        <span className={cn(isEmpty ? "text-muted-foreground italic" : "font-medium text-foreground")}>
          {subject || "(blank — sends as a reply in the same thread)"}
        </span>
      </div>
      {isEmpty ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing written for this follow-up yet. Add content on the Content tab, or
          delete the step.
        </p>
      ) : (
        <div
          className="prose-email px-4 py-4 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_p]:mb-3"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
      {/*
        Shown on the preview because this is the last screen before Launch, and an
        attachment is part of what goes out — a resume silently missing (or silently
        present) is exactly the kind of thing this page exists to catch.
      */}
      {!isEmpty && step.attachments && step.attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
          <Paperclip className="size-3.5" />
          {step.attachments.map((file) => (
            <span
              key={file.id}
              className="rounded-md border bg-muted/40 px-2 py-1 text-foreground"
            >
              {file.filename}{" "}
              <span className="text-muted-foreground">
                {formatAttachmentSize(file.sizeBytes)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function WaitDivider({ days }: { days: number }) {
  return (
    <div className="flex items-center gap-3 px-2 text-sm text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <Clock className="size-3.5" /> If no reply, wait {days} day{days === 1 ? "" : "s"}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
