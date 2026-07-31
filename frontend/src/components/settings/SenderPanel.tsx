import { Bold, HeartPulse, Image, Italic, Link as LinkIcon, MoreVertical } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { lastSevenDays } from "@/lib/time"
import type { SenderAccount } from "@/lib/types"

interface SenderPanelProps {
  sender: SenderAccount | null
  onOpenChange: (open: boolean) => void
  onUpdate: (patch: Partial<SenderAccount>) => void
  /** Database totals shown on the Usage tab. */
  recipientsAllocated?: number
  emailsScheduled?: number
}

function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
}

/** Right slide-over: sender profile, signature, sending capacity + usage. */
export function SenderPanel({
  sender,
  onOpenChange,
  onUpdate,
  recipientsAllocated = 0,
  emailsScheduled = 0,
}: SenderPanelProps) {
  return (
    <Dialog open={!!sender} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="fixed top-0 right-0 left-auto h-svh w-full max-w-md translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-none border-l p-0 sm:max-w-md"
      >
        {sender && (
          <div className="p-6">
            <DialogTitle className="sr-only">Sender account settings</DialogTitle>

            {/* Header */}
            <div className="flex items-center gap-3">
              <Avatar className="size-12 bg-accent/15">
                <AvatarFallback className="bg-accent/15 font-medium text-accent">
                  {initials(sender.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">{sender.email}</p>
                <p className="text-sm text-muted-foreground">{sender.name}</p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Badge className="bg-success/10 text-success">Active</Badge>
              <Badge variant="secondary">{sender.provider}</Badge>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5">
                <HeartPulse className="size-4" /> Run health check
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="More">
                <MoreVertical />
              </Button>
            </div>

            <Tabs defaultValue="profile" className="mt-5">
              <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0">
                <TabsTrigger value="profile" className="rounded-none">Profile</TabsTrigger>
                <TabsTrigger value="usage" className="rounded-none">Usage</TabsTrigger>
              </TabsList>

              {/* Profile tab */}
              <TabsContent value="profile" className="mt-5 space-y-5">
                <div className="space-y-1.5">
                  <Label>Sender name</Label>
                  <Input
                    value={sender.name}
                    onChange={(e) => onUpdate({ name: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Signature</Label>
                    <button className="text-xs font-medium text-accent hover:underline">
                      Copy from Gmail
                    </button>
                  </div>
                  <div className="rounded-lg border">
                    <div className="min-h-24 px-3 py-2 text-sm text-muted-foreground" />
                    <div className="flex items-center gap-1 border-t px-2 py-1 text-muted-foreground">
                      <Bold className="size-4" />
                      <Italic className="size-4" />
                      <LinkIcon className="size-4" />
                      <Image className="size-4" />
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Daily limit</Label>
                  <Input
                    type="number"
                    min={1}
                    value={sender.dailyLimit}
                    onChange={(e) => onUpdate({ dailyLimit: Number(e.target.value) })}
                    className="w-40"
                  />
                  <p className="text-xs text-muted-foreground">
                    Recommendation: 15 emails/day for safe deliverability.
                  </p>
                </div>

                <Button className="w-full">Save profile</Button>
              </TabsContent>

              {/* Usage tab */}
              <TabsContent value="usage" className="mt-5">
                <UsageTab
                  sender={sender}
                  recipientsAllocated={recipientsAllocated}
                  emailsScheduled={emailsScheduled}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function UsageTab({
  sender,
  recipientsAllocated,
  emailsScheduled,
}: {
  sender: SenderAccount
  recipientsAllocated: number
  emailsScheduled: number
}) {
  const sent = sender.sentToday
  const scheduled = emailsScheduled
  const available = Math.max(0, sender.dailyLimit - sent - scheduled)
  const total = sender.dailyLimit || 1
  const pct = (n: number) => `${(n / total) * 100}%`

  return (
    <div className="space-y-8">
      {/* Sending limits */}
      <section>
        <h3 className="font-semibold text-foreground">Sending limits</h3>
        <p className="mt-3 text-sm font-medium text-foreground">Today</p>

        {/* Stacked usage bar */}
        <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="bg-accent" style={{ width: pct(sent) }} />
          <div className="bg-muted-foreground/40" style={{ width: pct(scheduled) }} />
        </div>

        <div className="mt-3 grid grid-cols-3 text-sm">
          <UsageStat color="bg-accent" label="Sent" value={sent} />
          <UsageStat color="bg-muted-foreground/40" label="Scheduled" value={scheduled} />
          <UsageStat
            color="bg-muted"
            label="Available"
            value={available}
            align="right"
          />
        </div>

        <p className="mt-6 text-sm font-medium text-foreground">7 day history</p>
        <SevenDayHistory sent={sent} dailyLimit={sender.dailyLimit} />
      </section>

      {/* Database usage — recipients are launched one at a time. */}
      <section>
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-foreground">Database</h3>
          <Badge variant="secondary" className="rounded-full">
            {recipientsAllocated}
          </Badge>
        </div>
        <div className="mt-3 flex items-center justify-between border-t pt-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              {recipientsAllocated} recipients
            </p>
            <p className="text-xs text-muted-foreground">
              {emailsScheduled} launched · {recipientsAllocated - emailsScheduled} still
              draft
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

function UsageStat({
  color,
  label,
  value,
  align = "left",
}: {
  color: string
  label: string
  value: number
  align?: "left" | "right"
}) {
  return (
    <div className={cn(align === "right" && "text-right")}>
      <div
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground",
          align === "right" && "justify-end"
        )}
      >
        <span className={cn("size-2.5 rounded-sm", color)} />
        {label}
      </div>
      <p className="mt-0.5 text-lg font-semibold text-foreground">{value}</p>
    </div>
  )
}

/** Last-7-days sent bar chart with a hover tooltip per day. */
function SevenDayHistory({ sent, dailyLimit }: { sent: number; dailyLimit: number }) {
  // Only today has real data; earlier days are 0 until sending history exists.
  const days = lastSevenDays().map((d, i, arr) => ({
    ...d,
    sent: i === arr.length - 1 ? sent : 0,
  }))
  const max = Math.max(dailyLimit, ...days.map((d) => d.sent), 1)

  return (
    <div className="mt-2 flex h-24 items-end gap-2">
      {days.map((d) => {
        const hPct = Math.max(6, (d.sent / max) * 100)
        return (
          <div key={d.iso} className="group relative flex flex-1 items-end">
            <div
              className={cn(
                "w-full rounded-sm transition-colors",
                d.sent > 0 ? "bg-accent" : "bg-muted group-hover:bg-muted-foreground/25"
              )}
              style={{ height: `${hPct}%` }}
            />
            {/* Tooltip */}
            <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 rounded-lg bg-[oklch(0.24_0.02_264)] px-3 py-2 text-left whitespace-nowrap text-white shadow-lg group-hover:block">
              <p className="text-xs font-semibold">{d.label}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs">
                <span className="size-2 rounded-sm bg-accent" /> Sent: {d.sent}
              </p>
              <p className="flex items-center gap-1.5 text-xs">
                <span className="size-2 rounded-sm bg-white/40" /> Remaining:{" "}
                {Math.max(0, dailyLimit - d.sent)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
