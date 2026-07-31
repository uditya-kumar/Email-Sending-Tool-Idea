import { useState } from "react"
import {
  ChevronDown,
  Clock,
  Copy,
  Mail,
  Minus,
  MoreVertical,
  Plus,
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
import type { SequenceStep } from "@/lib/types"

interface SequenceSidebarProps {
  steps: SequenceStep[]
  activeStepId: string
  onSelect: (id: string) => void
  onAddStep: () => void
  onDuplicateStep: (id: string) => void
  onDeleteStep: (id: string) => void
  onChangeDelay: (id: string, waitDays: number) => void
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
}: SequenceSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1
          return (
            <div key={step.id}>
              {step.kind === "email" ? (
                <EmailCard
                  step={step}
                  active={step.id === activeStepId}
                  onClick={() => onSelect(step.id)}
                  onDuplicate={() => onDuplicateStep(step.id)}
                  onDelete={() => onDeleteStep(step.id)}
                />
              ) : (
                <DelayCard
                  step={step}
                  onChange={(days) => onChangeDelay(step.id, days)}
                />
              )}
              {!isLast && <StepConnector />}
            </div>
          )
        })}

        <Button
          variant="outline"
          className="mt-2 w-full justify-center gap-1.5 border-dashed"
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

function EmailCard({
  step,
  active,
  onClick,
  onDuplicate,
  onDelete,
}: {
  step: SequenceStep
  active: boolean
  onClick: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const missing = !step.subject && !step.bodyHtml
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
        {missing && (
          <span className="block text-xs text-muted-foreground italic">
            Missing content
          </span>
        )}
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
            onSelect={onDuplicate}
            onClick={(e) => e.stopPropagation()}
          >
            <Copy className="size-4" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
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
}: {
  step: SequenceStep
  onChange: (days: number) => void
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
                disabled={days <= 1}
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
