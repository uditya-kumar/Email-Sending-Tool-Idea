import { Copy, FileText, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { describeSequence } from "@/lib/sequence"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { EmailTemplate } from "@/lib/types"

interface TemplateSidebarProps {
  templates: EmailTemplate[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  /** Opens the rename dialog for this template. */
  onRename: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

/** Left rail on the Templates page: the list of saved templates. */
export function TemplateSidebar({
  templates,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onDuplicate,
  onDelete,
}: TemplateSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-sm font-medium text-foreground">Templates</span>
        <span className="text-xs text-muted-foreground">{templates.length}</span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            active={template.id === activeId}
            onClick={() => onSelect(template.id)}
            onRename={() => onRename(template.id)}
            onDuplicate={() => onDuplicate(template.id)}
            onDelete={() => onDelete(template.id)}
          />
        ))}

        <Button
          variant="outline"
          className="mt-2 w-full justify-center gap-1.5 border-dashed"
          onClick={onAdd}
        >
          <Plus className="size-4" /> New template
        </Button>
      </div>
    </aside>
  )
}

function TemplateCard({
  template,
  active,
  onClick,
  onRename,
  onDuplicate,
  onDelete,
}: {
  template: EmailTemplate
  active: boolean
  onClick: () => void
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
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
        <FileText className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {template.name || "Untitled template"}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {describeSequence(template.steps)}
        </span>
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Template options"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-muted-foreground"
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuItem
            onSelect={onRename}
            onClick={(e) => e.stopPropagation()}
          >
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
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
            <Trash2 className="size-4" /> Delete template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
