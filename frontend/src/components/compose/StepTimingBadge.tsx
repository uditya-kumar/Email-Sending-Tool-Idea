import { AlertCircle, CheckCircle2, Clock, Send, XCircle } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatISTClock, formatISTDay, formatISTDayTime, istDayDelta } from "@/lib/time"
import { cn } from "@/lib/utils"
import type { StepTiming } from "@/lib/types"

interface StepTimingBadgeProps {
  /** Undefined while the queue is still being read — renders nothing. */
  timing: StepTiming | undefined
}

/**
 * The line under an email step in the sequence rail: "Sent Tue 4 Aug, 9:30 AM",
 * "Sends tomorrow", "Sends in 3 days".
 *
 * Deliberately distinguishes **certainty**, not just state. A queued row and a
 * projection look almost the same to a user, but only the first is a commitment:
 * follow-ups are queued one at a time, so a step two places out has no row yet and
 * its time shifts if the email before it goes out late. The projected variant is
 * therefore muted and marked "≈", with the reason in the tooltip — while a sent
 * step, which is history, is stated flatly.
 */
export function StepTimingBadge({ timing }: StepTimingBadgeProps) {
  if (!timing) return null

  const { label, detail, icon: Icon, tone } = describe(timing)

  return (
    // One provider per badge rather than one at the app root, so this component is
    // droppable anywhere without a setup step. It holds only context and the
    // skip-delay timer, so the cost is a closure per card.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("mt-0.5 flex items-start gap-1 text-xs", tone)}>
            {/* `mt-px` optically centres the icon on the first line once the label
                is allowed to run to two of them. */}
            <Icon className="mt-px size-3 shrink-0" />
            {/*
              Wrapped, not truncated. The rail is 16rem and this line shares its row
              with an icon and a menu button — and narrows further when the rail
              gains a scrollbar, which is exactly when a fixed label would start
              losing its last characters. A time cut off mid-way ("Sent today, 9:3…")
              is worse than a slightly taller card, and the whole point of the line
              is the time. `formatISTClock` holds the "AM" to the digits with a
              non-breaking space so the wrap can only fall at a sensible place.
            */}
            <span>{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="block max-w-xs">{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface Described {
  label: string
  detail: string
  icon: typeof Clock
  tone: string
}

function describe(timing: StepTiming): Described {
  switch (timing.kind) {
    case "sent":
      return {
        label: `Sent ${when(timing.at)}`,
        detail: `Delivered ${formatISTDayTime(timing.at)} IST. Editing this email won't change what the recipient already received.`,
        icon: CheckCircle2,
        tone: "text-success",
      }

    case "sending":
      return {
        label: "Sending now",
        detail:
          "The scheduler has claimed this email and is sending it. Edits from here on won't make it into the message.",
        icon: Send,
        tone: "text-accent",
      }

    case "scheduled":
      return {
        label: `Sends ${when(timing.at)}`,
        detail: `Queued for ${formatISTDayTime(timing.at)} IST. This one is committed — the scheduler has a row for it — but it still won't send if the recipient replies first.`,
        icon: Clock,
        tone: "text-foreground",
      }

    case "projected":
      return {
        // The "≈" carries the hedge at a glance; the tooltip explains it.
        label: `Sends ≈ ${when(timing.at)}`,
        detail: `Estimated ${formatISTDayTime(timing.at)} IST, counted from the email before it at this recipient's send time. Not queued yet — each follow-up is scheduled only once the previous email has actually gone out, so this moves if that one sends late, if you change a wait, or if the sending days in Settings change.`,
        icon: Clock,
        tone: "text-muted-foreground",
      }

    case "stopped":
      return {
        /*
         * The cause is in the label, not only the tooltip. "Won't send" alone is
         * the state without the reason, and on a replied lead every remaining card
         * shows it — which reads as several things having gone wrong rather than as
         * one good thing having happened. Matched on `cause` rather than on the
         * prose so rewording the sentence can't silently change the label.
         */
        label:
          timing.cause === "replied" ? "Won't send — replied" : "Won't send",
        detail: `This email won't go out because ${timing.reason}.`,
        icon: XCircle,
        tone: "text-muted-foreground",
      }

    case "blocked":
      return {
        label: "Can't be scheduled",
        detail: `No send time could be worked out: ${timing.reason}.`,
        icon: AlertCircle,
        tone: "text-destructive",
      }
  }
}

/**
 * When, as a date: "today, 9:35 AM", "tomorrow, 9:35 AM", "5 Aug".
 *
 * A **date rather than a day count** past tomorrow. "In 3 days" forces the reader
 * to do arithmetic against a today they have to remember, and it is arithmetic
 * they can't check — the scheduler skips days the settings exclude, so a 3-day
 * wait does not reliably land 3 days out and a count that says otherwise is
 * quietly wrong. "5 Aug" is the thing the user actually wants to put in a
 * calendar, and it stays true no matter which weekdays are enabled.
 *
 * The clock time is kept only within a day either side. That is where the minute
 * is the interesting part ("has it gone yet?"), and it is the only range narrow
 * enough to afford it: the rail is 16rem and this line shares its row with an
 * icon and a menu button, which "Sun 2 Aug, 9:35 AM" overflows. Further out the
 * date carries it and the exact minute is in the tooltip, which shows
 * `formatISTDayTime` — weekday included — for every one of these.
 */
function when(iso: string): string {
  const days = istDayDelta(iso)
  if (days === null) return iso

  if (days === 0) return `today, ${formatISTClock(iso)}`
  if (days === 1) return `tomorrow, ${formatISTClock(iso)}`
  if (days === -1) return `yesterday, ${formatISTClock(iso)}`

  return formatISTDay(iso)
}
