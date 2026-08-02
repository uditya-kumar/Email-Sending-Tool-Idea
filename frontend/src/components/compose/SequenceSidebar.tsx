import { useState } from "react"
import {
  ChevronDown,
  Clock,
  Copy,
  Mail,
  Minus,
  MoreVertical,
  Plus,
  Reply,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { StepTimingBadge } from "./StepTimingBadge"
import type { SequenceStep, StepTiming } from "@/lib/types"

interface SequenceSidebarProps {
  steps: SequenceStep[]
  activeStepId: string
  onSelect: (id: string) => void
  onAddStep: () => void
  onDuplicateStep: (id: string) => void
  onDeleteStep: (id: string) => void
  onChangeDelay: (id: string, waitDays: number) => void
  /**
   * When each email is due, keyed by step id — see `projectSequenceSchedule`.
   *
   * Optional because the Templates page reuses this rail, and a template has no
   * recipient and no queue: there is genuinely no answer to "when does this send",
   * so the badges are absent there rather than faked.
   */
  timings?: Map<string, StepTiming> | undefined
  /**
   * The step after which the recipient replied — see `SequenceSchedule`.
   *
   * The marker goes on the connector *below* that card rather than on the card
   * itself, because that is where it happened: the email above it is what the
   * recipient answered, and everything below it is what the answer called off.
   * Optional for the same reason as `timings` — a template has no recipient to
   * reply.
   */
  replyAfterStepId?: string | null | undefined
  /**
   * True while a structural save is in flight.
   *
   * Only the buttons that *change the list* are disabled — selecting a step still
   * works, and blocking that would be gratuitous. The reason the others can't wait
   * their turn: each one sends the whole list in one statement, computed from the
   * positions currently on screen. A second click before the first save's read-back
   * lands would compute from stale positions and race the write that's already out.
   */
  busy?: boolean | undefined
}

/** Left rail on the Content step: ordered email + wait cards. */
export function SequenceSidebar({
  steps,
  activeStepId,
  onSelect,
  onAddStep,
  onDuplicateStep,
  onDeleteStep,
  onChangeDelay,
  timings,
  replyAfterStepId,
  busy,
}: SequenceSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1
          const repliedHere = step.id === replyAfterStepId
          return (
            <div key={step.id}>
              {step.kind === "email" ? (
                <EmailCard
                  step={step}
                  active={step.id === activeStepId}
                  onClick={() => onSelect(step.id)}
                  onDuplicate={() => onDuplicateStep(step.id)}
                  onDelete={() => onDeleteStep(step.id)}
                  timing={timings?.get(step.id)}
                  busy={busy}
                />
              ) : (
                <DelayCard
                  step={step}
                  onChange={(days) => onChangeDelay(step.id, days)}
                  busy={busy}
                />
              )}
              {/*
                The reply replaces the plain connector rather than sitting beside
                it: it *is* what happened at this point in the line. Still rendered
                when this is the last step — the sequence ending here is exactly
                what a reply on the final email means, and dropping the marker
                would lose the one event the user most wants to see.
              */}
              {repliedHere ? <ReplyMarker /> : !isLast && <StepConnector />}
            </div>
          )
        })}

        <Button
          variant="outline"
          className="mt-2 w-full justify-center gap-1.5 border-dashed"
          disabled={busy}
          onClick={onAddStep}
        >
          <Plus className="size-4" /> Add step
        </Button>
      </div>
    </aside>
  )
}

function StepConnector() {
  return <div className="mx-auto my-1 h-4 w-px bg-border" />
}

/**
 * "Replied" on the vertical line, where the reply landed.
 *
 * The success colour, because this is the win — every other state in this rail is
 * either neutral or a warning, and a reply is the outcome the whole sequence is
 * for. It is also the reason the cards below it say "Won't send": the two are
 * cause and effect, so they are deliberately legible together rather than the
 * cancellations reading as an unexplained failure.
 *
 * The hairline stays on the rail's centre line with the label set beside it, so
 * the thread reads as continuing *through* the reply rather than being cut in two
 * — the reply interrupts the sequence, it doesn't end the diagram.
 */
function ReplyMarker() {
  return (
    <div className="my-1 flex items-center gap-1.5">
      <div className="ml-[calc(50%-0.5px)] h-4 w-px shrink-0 bg-success/40" />
      <span className="flex items-center gap-1 text-xs font-medium text-success">
        <Reply className="size-3" />
        Replied
      </span>
    </div>
  )
}

function EmailCard({
  step,
  active,
  onClick,
  onDuplicate,
  onDelete,
  timing,
  busy,
}: {
  step: SequenceStep
  active: boolean
  onClick: () => void
  onDuplicate: () => void
  onDelete: () => void
  timing?: StepTiming | undefined
  busy?: boolean | undefined
}) {
  const missing = !step.subject && !step.bodyHtml
  /*
   * "Missing content" is suppressed once the email has gone out: whatever was in
   * it then is what the recipient received, and the fields being blank *now* would
   * only mean the step was edited afterwards. Warning about it would suggest
   * something is still fixable.
   */
  const showMissing = missing && timing?.kind !== "sent"
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border bg-card p-3 text-left transition-colors",
        active
          ? "border-accent ring-1 ring-accent/40"
          : "hover:border-muted-foreground/30"
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          active ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"
        )}
      >
        <Mail className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {step.name}
        </span>
        {showMissing && (
          <span className="block text-xs text-muted-foreground italic">
            Missing content
          </span>
        )}
        <StepTimingBadge timing={timing} />
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Step options"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-muted-foreground"
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuItem
            // `?? false` because Radix types this as a required boolean, and
            // `exactOptionalPropertyTypes` won't let an optional prop through.
            disabled={busy ?? false}
            onSelect={onDuplicate}
            onClick={(e) => e.stopPropagation()}
          >
            <Copy className="size-4" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            // `?? false` because Radix types this as a required boolean, and
            // `exactOptionalPropertyTypes` won't let an optional prop through.
            disabled={busy ?? false}
            onSelect={onDelete}
            onClick={(e) => e.stopPropagation()}
          >
            <Trash2 className="size-4" /> Delete step
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function DelayCard({
  step,
  onChange,
  busy,
}: {
  step: SequenceStep
  onChange: (days: number) => void
  busy?: boolean | undefined
}) {
  const [open, setOpen] = useState(false)
  const days = step.waitDays ?? 3

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 text-sm text-muted-foreground transition-colors",
          open ? "bg-muted/60" : "bg-muted/40 hover:bg-muted/60"
        )}
      >
        <Clock className="size-4" />
        Wait for <span className="font-medium text-foreground">{days} days</span>
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="mt-1 rounded-lg border bg-card p-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Decrease days"
                disabled={busy || days <= 1}
                onClick={() => onChange(Math.max(1, days - 1))}
              >
                <Minus />
              </Button>
              <span className="w-8 text-center text-sm font-medium text-foreground">
                {days}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Increase days"
                disabled={busy}
                onClick={() => onChange(days + 1)}
              >
                <Plus />
              </Button>
            </div>
            <span className="text-sm text-muted-foreground">day(s)</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            If there's no reply, send a follow-up after this many days.
          </p>
        </div>
      )}
    </div>
  )
}
