import { useMemo } from "react"
import type { ColumnDef, RowData } from "@tanstack/react-table"
import { Pencil, Send, Trash2 } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LeadStatusBadge } from "@/components/common/StatusBadge"
import type { Lead } from "@/lib/types"

// Extend TanStack column meta with our layout hints.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    minWidth?: string
    /** Pin the column to the right edge while the table scrolls horizontally. */
    sticky?: boolean
  }
}

interface UseLeadColumnsArgs {
  onEditTime: (id: string, value: string) => void
  onDelete: (id: string) => void
  onEdit: (lead: Lead) => void
  /** Opens this recipient's own Content → Preview → Launch flow. */
  onSend: (lead: Lead) => void
}

/** TanStack column definitions for the Database leads table. */
export function useLeadColumns({
  onEditTime,
  onDelete,
  onEdit,
  onSend,
}: UseLeadColumnsArgs): ColumnDef<Lead>[] {
  return useMemo<ColumnDef<Lead>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            aria-label="Select row"
          />
        ),
        enableSorting: false,
        size: 40,
      },
      {
        accessorKey: "email",
        header: "Email address",
        cell: ({ row }) => (
          <span className="font-medium whitespace-nowrap text-foreground">
            {row.original.email}
          </span>
        ),
        meta: { minWidth: "200px" },
      },
      {
        accessorKey: "contactFullName",
        header: "Contact person",
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.contactFullName}</span>
        ),
        meta: { minWidth: "170px" },
      },
      {
        accessorKey: "companyName",
        header: "Company",
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.companyName}</span>
        ),
        meta: { minWidth: "150px" },
      },
      {
        accessorKey: "personalizationLine",
        header: "Personalization line",
        // Kept to one line with an ellipsis so rows stay uniform height; the
        // full (possibly multiline) value is in the title tooltip.
        cell: ({ row }) => (
          <span
            title={row.original.personalizationLine || undefined}
            className="block max-w-[280px] truncate whitespace-nowrap text-muted-foreground"
          >
            {row.original.personalizationLine || "—"}
          </span>
        ),
        meta: { minWidth: "220px" },
      },
      {
        accessorKey: "jobTitle",
        header: "Job title",
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.jobTitle || "—"}</span>
        ),
        meta: { minWidth: "150px" },
      },
      {
        accessorKey: "website",
        header: "Website",
        cell: ({ row }) =>
          row.original.website ? (
            <a
              href={row.original.website}
              target="_blank"
              rel="noreferrer"
              className="whitespace-nowrap text-accent underline-offset-2 hover:underline"
            >
              {row.original.website.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        meta: { minWidth: "160px" },
      },
      {
        accessorKey: "sendTimeIST",
        header: "Send time (IST)",
        cell: ({ row }) => (
          <Input
            type="time"
            value={row.original.sendTimeIST}
            onChange={(e) => onEditTime(row.original.id, e.target.value)}
            className="h-8 w-28"
          />
        ),
        meta: { minWidth: "140px" },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <LeadStatusBadge status={row.original.status} />,
        meta: { minWidth: "120px" },
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        meta: { sticky: true, minWidth: "180px" },
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            {/* Entry point into this recipient's own compose flow. */}
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => onSend(row.original)}
            >
              <Send className="size-3.5" />
              {row.original.status === "draft" ? "Send" : "Open"}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => onEdit(row.original)}
              aria-label="Edit lead"
            >
              <Pencil />
            </Button>
            <Button
              variant="destructive"
              size="icon-sm"
              onClick={() => onDelete(row.original.id)}
              aria-label="Delete lead"
            >
              <Trash2 />
            </Button>
          </div>
        ),
      },
    ],
    [onEditTime, onDelete, onEdit, onSend]
  )
}
