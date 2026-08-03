import { AlertTriangle, ArrowLeft, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { describeSplit } from "@shared/send-budget.ts"
import { cn } from "@/lib/utils"
import type { SenderAccount, SequenceSettings, Weekday } from "@/lib/types"

const WEEKDAYS: { value: Weekday; label: string }[] = [
  { value: 0, label: "Monday" },
  { value: 1, label: "Tuesday" },
  { value: 2, label: "Wednesday" },
  { value: 3, label: "Thursday" },
  { value: 4, label: "Friday" },
  { value: 5, label: "Saturday" },
  { value: 6, label: "Sunday" },
]

interface SettingsPageProps {
  senders: SenderAccount[]
  settings: SequenceSettings
  onSettingsChange: (patch: Partial<SequenceSettings>) => void
  /** Opens the daily send budget dialog (cap + follow-up share) for this account. */
  onEditSender: (sender: SenderAccount) => void
  /** Disconnects the account from sending. Doesn't touch the user's profile. */
  onRemoveSender: (sender: SenderAccount) => void
  /** Persists the tracking + weekday settings. */
  onSaveSchedule: () => void
  /** True while the settings row is being read, so the controls aren't editable yet. */
  settingsLoading?: boolean | undefined
  /** True when there are unsaved local changes. */
  settingsDirty?: boolean | undefined
  /** True from the Save click until the write resolves. */
  savingSettings?: boolean | undefined
  /**
   * Starts Google OAuth consent. A navigation away from the app, not a dialog —
   * the user comes back via a redirect.
   */
  onConnect: () => void
  /** True while the consent URL (which needs a fresh token) is being built. */
  connecting?: boolean | undefined
  /** Returns to whichever page Settings was opened from. */
  onBack: () => void
  /** Label for the Back button, e.g. "Database" or "Templates". */
  backLabel: string
}

/** Row with a label/description on the left and a control on the right. */
function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  // `| undefined` spelled out because `exactOptionalPropertyTypes` makes "absent"
  // and "present but undefined" different types, and callers pass an optional prop
  // straight through. Same as `WeekdayRow` below.
  disabled?: boolean | undefined
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-3.5",
        disabled && "opacity-60"
      )}
    >
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

/** One labelled Mon–Sun checkbox row. Rendered once per send type. */
function DayPicker({
  label,
  hint,
  selected,
  onToggle,
  disabled,
}: {
  label: string
  hint: string
  selected: Weekday[]
  onToggle: (day: Weekday) => void
  /** Set while the row is still being read — see the call site. */
  disabled?: boolean | undefined
}) {
  return (
    <div className={cn("space-y-2", disabled && "pointer-events-none opacity-60")}>
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {/* Single row, Mon–Sun — scrolls rather than wraps on narrow viewports. */}
      <div className="-mx-1 flex flex-nowrap gap-2 overflow-x-auto px-1 py-1">
        {WEEKDAYS.map((day) => {
          const active = selected.includes(day.value)
          /*
           * The last enabled day is locked on. Nothing can be scheduled against an
           * empty list — every date function throws rather than guessing — so
           * allowing it would let one checkbox silently stop all sending. Shown as
           * disabled rather than rejected on click, because a checkbox that ignores
           * you reads as a broken checkbox.
           */
          const isLastEnabled = active && selected.length === 1
          return (
            <label
              key={day.value}
              title={isLastEnabled ? "At least one day has to stay enabled." : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm whitespace-nowrap transition-colors",
                isLastEnabled ? "cursor-not-allowed" : "cursor-pointer",
                !active && "hover:border-muted-foreground/30"
              )}
            >
              <Checkbox
                checked={active}
                disabled={disabled || isLastEnabled}
                onCheckedChange={() => onToggle(day.value)}
              />
              {day.label}
            </label>
          )
        })}
      </div>
    </div>
  )
}

function SectionHeading({
  title,
  description,
  badge,
}: {
  title: string
  description: string
  /** Optional pill beside the title, e.g. "Coming soon". */
  badge?: string
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

/**
 * Standalone Settings page (opened from the header gear): sender accounts,
 * tracking, and the global sending window that every recipient's send respects.
 */
export function SettingsPage({
  senders,
  settings,
  onSettingsChange,
  onEditSender,
  onRemoveSender,
  onSaveSchedule,
  settingsLoading,
  settingsDirty,
  savingSettings,
  onConnect,
  connecting,
  onBack,
  backLabel,
}: SettingsPageProps) {
  /**
   * Add/remove a day in whichever of the two day lists was clicked.
   *
   * The last remaining day cannot be removed. An empty list has no meaning the
   * scheduler can act on — "never send" is what pausing a lead is for — and it used
   * to be actively destructive: every scheduling function raises `NoAllowedDayError`
   * rather than inventing a day, so clearing one list stalled the whole send queue
   * from a single checkbox, with no error anywhere the user could see it. The
   * checkbox is also rendered disabled at that point, so this is the second line of
   * defence rather than the explanation.
   */
  function toggleDay(key: "outreachDays" | "followUpDays", day: Weekday) {
    const current = settings[key]

    if (current.includes(day)) {
      if (current.length === 1) return
      onSettingsChange({ [key]: current.filter((d) => d !== day) })
      return
    }

    onSettingsChange({ [key]: [...current, day].sort((a, b) => a - b) })
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-6 py-8 sm:px-12 lg:px-20">
      <div>
        {/* Back to wherever Settings was opened from. */}
        <div className="mb-3 flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={`Back to ${backLabel}`}
          >
            <ArrowLeft />
          </Button>
          <button
            onClick={onBack}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {backLabel}
          </button>
          <span className="text-sm text-muted-foreground">/</span>
          <span className="text-sm font-medium text-foreground">Settings</span>
        </div>

        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Sending account, tracking and the global window. These apply to every
          recipient you launch from the Database.
        </p>
      </div>

      {/* Sender accounts */}
      <section>
        <SectionHeading
          title="Sender account"
          description="The Gmail account every email is sent from, how many it may send per day, and how that day is split between follow-ups and new outreach."
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/60 hover:bg-muted/60">
                <TableHead>Email account</TableHead>
                <TableHead>Send budget</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {senders.length ? (
                senders.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <p className="font-medium text-foreground">{s.email}</p>
                      {/*
                        A revoked or expired refresh token is otherwise invisible
                        until a send fails, which for a scheduled campaign means
                        finding out hours later. Reconnecting is the same consent
                        flow as adding — Google just replaces the token.
                      */}
                      {s.status === "active" ? (
                        <p className="text-xs text-muted-foreground">{s.name}</p>
                      ) : (
                        <button
                          onClick={onConnect}
                          disabled={connecting}
                          className="mt-0.5 flex items-center gap-1 text-xs font-medium text-destructive hover:underline disabled:opacity-60"
                        >
                          <AlertTriangle className="size-3" />
                          {s.status === "revoked"
                            ? "Access revoked — reconnect"
                            : "Needs reauthorization — reconnect"}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <p>{s.dailyLimit}/day</p>
                      {/*
                        The split is shown, not just the total, because it decides
                        *which* emails go out on a day the cap is hit — a fact that
                        would otherwise only be discoverable by opening the dialog
                        or by noticing which recipients were postponed.
                      */}
                      <p className="text-xs">
                        {describeSplit(s.dailyLimit, s.followUpSharePct)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="Edit send budget"
                          onClick={() => onEditSender(s)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="destructive"
                          size="icon-sm"
                          aria-label="Disconnect account"
                          onClick={() => onRemoveSender(s)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="h-20 text-center text-muted-foreground"
                  >
                    No account connected — nothing can send until you add one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {/*
          Only one account is supported: the test-send and launch paths both
          refuse with `ambiguous_account` rather than guessing which of several to
          send from. So once one is connected there is nothing to add.
        */}
        {senders.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3 gap-1.5"
            onClick={onConnect}
            disabled={connecting}
          >
            {connecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {connecting ? "Opening Google…" : "Connect Gmail account"}
          </Button>
        )}
      </section>

      {/* Tracking */}
      <section>
        <SectionHeading
          title="Tracking"
          description="Counted per recipient and shown in the Database table's Opens / clicks column. Applies to emails sent from now on — a message already delivered can't be changed."
        />
        <div className="divide-y rounded-xl border bg-card">
          <ToggleRow
            title="Track email opens"
            // The caveat is the useful half: Apple Mail Privacy Protection and
            // Gmail's proxy fetch the pixel before anyone reads anything, which
            // is why the table shows a count rather than "Opened".
            description="Adds an invisible image to each email. One open often means a mail client pre-loading images; a second open is a real read."
            checked={settings.trackOpens}
            onChange={(v) => onSettingsChange({ trackOpens: v })}
            disabled={settingsLoading}
          />
          <ToggleRow
            title="Track link clicks"
            description="Routes links through a redirect so clicks are counted. Unlike opens, nothing clicks a link automatically — this is the signal to trust."
            checked={settings.trackClicks}
            onChange={(v) => onSettingsChange({ trackClicks: v })}
            disabled={settingsLoading}
          />
        </div>
      </section>

      {/* Sending days — first touches and follow-ups get their own schedules. */}
      <section>
        <SectionHeading
          title="Sending days"
          description="Days sends are allowed. A recipient whose IST send time falls on an excluded day waits for the next allowed one."
        />

        {/*
          Locked until the row has been read. The displayed values start as the
          column defaults, so a click landing before the fetch resolves would be
          silently overwritten by it — the user would watch their own change undo
          itself.
        */}
        <div className="space-y-5">
          <DayPicker
            label="Days for new lead outreach"
            hint="When a first-touch email to a brand-new lead may go out."
            selected={settings.outreachDays}
            onToggle={(d) => toggleDay("outreachDays", d)}
            disabled={settingsLoading}
          />
          <DayPicker
            label="Days for follow-up emails to go out"
            hint="When a follow-up in an existing thread may go out, if there's been no reply."
            selected={settings.followUpDays}
            onToggle={(d) => toggleDay("followUpDays", d)}
            disabled={settingsLoading}
          />
        </div>

        {/*
          Disabled when there's nothing to save, so the button doubles as the
          indicator of whether the local copy matches the database — these values
          change every future send, and "did that take?" is worth answering.
        */}
        <Button
          className="mt-5 gap-1.5"
          onClick={onSaveSchedule}
          disabled={savingSettings || settingsLoading || settingsDirty === false}
        >
          {savingSettings && <Loader2 className="size-4 animate-spin" />}
          {savingSettings ? "Saving…" : settingsDirty ? "Save settings" : "Saved"}
        </Button>
      </section>
    </div>
  )
}
