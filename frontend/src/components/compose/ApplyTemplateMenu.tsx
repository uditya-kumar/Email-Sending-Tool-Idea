import { FileText, LayoutTemplate } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { describeSequence } from "@/lib/sequence"
import type { EmailTemplate } from "@/lib/types"

interface ApplyTemplateMenuProps {
  templates: EmailTemplate[]
  /** Replaces this recipient's whole sequence with the template's steps. */
  onApply: (template: EmailTemplate) => void
  /** True while a structural save is in flight — this is one of those saves. */
  busy?: boolean | undefined
}

/**
 * Content-step picker: choosing a template fills the entire setup for this
 * recipient — every email, follow-up and wait, exactly as saved.
 */
export function ApplyTemplateMenu({
  templates,
  onApply,
  busy,
}: ApplyTemplateMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={busy}>
          <LayoutTemplate className="size-4" /> Use template
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Replaces every email and wait below
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {templates.length === 0 ? (
          <DropdownMenuItem disabled>No templates saved yet</DropdownMenuItem>
        ) : (
          templates.map((template) => (
            <DropdownMenuItem
              key={template.id}
              onSelect={() => onApply(template)}
              className="items-start gap-2.5"
            >
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {template.name || "Untitled template"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {describeSequence(template.steps)}
                </span>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
