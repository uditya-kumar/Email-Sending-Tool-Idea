import { Pencil, Plus } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { HOUR_OPTIONS, currentISTLabel } from "@/lib/time"
import { SenderStatusBadge } from "@/components/common/StatusBadge"
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
  onEditSender: (sender: SenderAccount) => void
  onSaveSchedule: () => void
}

/** Row with a label/description on the left and a control on the right. */
function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

/**
 * Standalone Settings page (opened from the header gear): sender accounts, BCC,
 * tracking, and the global sending window that every recipient's send respects.
 */
export function SettingsPage({
  senders,
  settings,
  onSettingsChange,
  onEditSender,
  onSaveSchedule,
}: SettingsPageProps) {
  function toggleDay(day: Weekday) {
    const has = settings.sendingDays.includes(day)
    const next = has
      ? settings.sendingDays.filter((d) => d !== day)
      : [...settings.sendingDays, day].sort((a, b) => a - b)
    onSettingsChange({ sendingDays: next })
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-10 px-6 py-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Sending account, tracking and the global window. These apply to every
          recipient you launch from the Database.
        </p>
      </div>

      {/* Sender accounts */}
      <section>
        <SectionHeading
          title="Sender accounts"
          description="Select the email account(s) to send the sequence. If multiple accounts are chosen, emails are distributed among them."
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/60 hover:bg-muted/60">
                <TableHead className="w-10">
                  <Checkbox defaultChecked />
                </TableHead>
                <TableHead>Email account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Allocated</TableHead>
                <TableHead>Sent/limit</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {senders.map((s) => (
                <TableRow key={s.id} className="bg-accent/5">
                  <TableCell>
                    <Checkbox defaultChecked />
                  </TableCell>
                  <TableCell>
                    <p className="font-medium text-foreground">{s.email}</p>
                    <p className="text-xs text-muted-foreground">{s.name}</p>
                  </TableCell>
                  <TableCell>
                    <SenderStatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.allocatedRecipients} recipients
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.sentToday}/{s.dailyLimit}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Edit sender"
                      onClick={() => onEditSender(s)}
                    >
                      <Pencil />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button variant="outline" size="sm" className="mt-3 gap-1.5">
          <Plus className="size-4" /> Add account
        </Button>

        {/* BCC */}
        <div className="mt-4 rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-foreground">Add BCC</p>
              <p className="text-sm text-muted-foreground">
                Send a hidden copy of every email to another address.
              </p>
            </div>
            <Switch
              checked={settings.bccEnabled}
              onCheckedChange={(v) => onSettingsChange({ bccEnabled: v })}
            />
          </div>
          {settings.bccEnabled && (
            <div className="border-t px-4 py-3">
              <Input
                type="email"
                placeholder="bcc@example.com"
                value={settings.bccAddress}
                onChange={(e) => onSettingsChange({ bccAddress: e.target.value })}
              />
            </div>
          )}
        </div>
      </section>

      {/* Tracking */}
      <section>
        <SectionHeading
          title="Tracking"
          description="Choose whether to track email opens and link clicks. Only available for HTML emails."
        />
        <div className="divide-y rounded-xl border bg-card">
          <ToggleRow
            title="Track email opens"
            description="See when your recipients open your emails. May require consent depending on region."
            checked={settings.trackOpens}
            onChange={(v) => onSettingsChange({ trackOpens: v })}
          />
          <ToggleRow
            title="Track link clicks"
            description="See when your recipients click the links in your emails."
            checked={settings.trackClicks}
            onChange={(v) => onSettingsChange({ trackClicks: v })}
          />
        </div>
      </section>

      {/* Sending window */}
      <section>
        <SectionHeading
          title="Sending window"
          description="Outer bounds for all sends. A recipient's own IST send time still decides when their email goes out — it just has to fall inside this window."
        />

        {/* Sending days */}
        <div className="space-y-2">
          <Label>Sending days</Label>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => {
              const active = settings.sendingDays.includes(day.value)
              return (
                <label
                  key={day.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                    active
                      ? "border-accent/50 bg-accent/5"
                      : "hover:border-muted-foreground/30"
                  )}
                >
                  <Checkbox
                    checked={active}
                    onCheckedChange={() => toggleDay(day.value)}
                  />
                  {day.label}
                </label>
              )
            })}
          </div>
        </div>

        {/* Sending hours */}
        <div className="mt-5 space-y-2">
          <Label>Sending hours</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={settings.sendWindowStart}
              onValueChange={(v) => onSettingsChange({ sendWindowStart: v })}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOUR_OPTIONS.map((h) => (
                  <SelectItem key={h.value} value={h.value}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">to</span>
            <Select
              value={settings.sendWindowEnd}
              onValueChange={(v) => onSettingsChange({ sendWindowEnd: v })}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOUR_OPTIONS.map((h) => (
                  <SelectItem key={h.value} value={h.value}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              In <span className="font-medium text-accent">(GMT+05:30) Chennai</span>{" "}
              · Currently {currentISTLabel()}
            </span>
          </div>
        </div>

        {/* Start on a specific day */}
        <div className="mt-5 rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-foreground">
                Start sends on a specific day
              </p>
              <p className="text-sm text-muted-foreground">
                Hold launched recipients until this date instead of sending today.
              </p>
            </div>
            <Switch
              checked={settings.startOnSpecificDay}
              onCheckedChange={(v) => onSettingsChange({ startOnSpecificDay: v })}
            />
          </div>
          {settings.startOnSpecificDay && (
            <div className="border-t px-4 py-3">
              <Input
                type="date"
                value={settings.startDate}
                onChange={(e) => onSettingsChange({ startDate: e.target.value })}
                className="w-48"
              />
            </div>
          )}
        </div>

        <Button className="mt-5" onClick={onSaveSchedule}>
          Save settings
        </Button>
      </section>
    </div>
  )
}
