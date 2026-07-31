import type { ColumnDef, RowData } from "@tanstack/react-table"
import { CalendarX, Pencil, Send, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LeadStatusBadge } from "@/components/common/StatusBadge"
import { SendTimePicker } from "@/components/common/SendTimePicker"
import type { Lead } from "@/lib/types"

// Extend TanStack column meta with our layout hints.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    minWidth?: string
    /** Pin the column to the right edge while the table scrolls horizontally. */
    sticky?: boolean
  }

  /**
   * Row actions reach the cells through table meta rather than being closed over
   * by the column defs. That's what lets the defs below be a module constant:
   * a new `cell` function is a new component type to React, so rebuilding the
   * columns every render would remount every cell — which pulled focus out of
   * the send-time input mid-edit, losing the second digit of a typed time.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    onEditTime: (id: string, value: string) => void
    onDelete: (id: string) => void
    onEdit: (lead: Lead) => void
    /** Opens this recipient's own Content → Preview → Launch flow. */
    onSend: (lead: Lead) => void
    /** Un-schedules a launched recipient, returning them to draft. */
    onCancelSchedule: (lead: Lead) => void
  }
}

/**
 * Column definitions for the Database leads table. A module constant on purpose
 * — see the TableMeta note above; these must keep the same identity across
 * renders so editing one cell doesn't remount the whole table.
 */
export const LEAD_COLUMNS: ColumnDef<Lead>[] = [
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
    accessorKey: "firstName",
    header: "First name",
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{row.original.firstName || "—"}</span>
    ),
    meta: { minWidth: "130px" },
  },
  {
    accessorKey: "lastName",
    header: "Last name",
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{row.original.lastName || "—"}</span>
    ),
    meta: { minWidth: "130px" },
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
    cell: ({ row, table }) => (
      <SendTimePicker
        value={row.original.sendTimeIST}
        onChange={(hhmm) => table.options.meta?.onEditTime(row.original.id, hhmm)}
      />
    ),
    meta: { minWidth: "150px" },
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
    cell: ({ row, table }) => {
      const actions = table.options.meta
      /*
       * A scheduled recipient is queued to send, so editing or deleting them
       * would silently diverge from what's about to go out. Cancelling the
       * schedule is the only action offered until they're back to draft.
       */
      return row.original.status === "scheduled" ? (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => actions?.onCancelSchedule(row.original)}
        >
          <CalendarX className="size-3.5" />
          Cancel schedule
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          {/* Entry point into this recipient's own compose flow. */}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => actions?.onSend(row.original)}
          >
            <Send className="size-3.5" />
            {row.original.status === "draft" ? "Send" : "Open"}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => actions?.onEdit(row.original)}
            aria-label="Edit lead"
          >
            <Pencil />
          </Button>
          <Button
            variant="destructive"
            size="icon-sm"
            onClick={() => actions?.onDelete(row.original.id)}
            aria-label="Delete lead"
          >
            <Trash2 />
          </Button>
        </div>
      )
    },
  },
]
