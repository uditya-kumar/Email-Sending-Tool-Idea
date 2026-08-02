import { useRef, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table"
import { FileUp, Filter, Loader2, Plus, Search, Upload, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { LEAD_COLUMNS } from "./leadColumns"
import { LeadDialog } from "./LeadDialog"
import { CancelScheduleDialog } from "./CancelScheduleDialog"
import { leadsToCsv, parseLeadsCsv, type RejectedRow } from "@/lib/csv"
import type { NewLead } from "@/lib/leads"
import type { EngagementStore } from "@/lib/engagement"
import type { LeadsStore } from "@/lib/use-leads"
import type { Lead } from "@/lib/types"

interface DatabasePageProps {
  /** Leads plus their persistence — see `useLeads`. */
  store: LeadsStore
  /** Per-recipient open/click counts — see `useEngagement`. */
  engagementStore: EngagementStore
  /** Opens the per-recipient compose flow (Content → Preview → Launch). */
  onSend: (lead: Lead) => void
  /** Cancels a launched recipient's pending sends. */
  onCancelSchedule: (lead: Lead) => void
  /**
   * A lead's rows are gone. `sequence_steps` cascades in Postgres, so this exists
   * to drop the now-orphaned sequence from memory rather than to delete anything.
   */
  onLeadDeleted: (id: string) => void
}

/**
 * How many bad rows to name individually before summarising.
 *
 * A toast listing 60 rows is unreadable and pushes everything else off screen.
 * Three is enough to show the *pattern* — one wrong column usually breaks every
 * row the same way — and the count carries the rest.
 */
const MAX_LISTED_REJECTS = 3

/**
 * Tell the user which rows didn't import and why.
 *
 * An error rather than a warning: these leads are silently absent, and the whole
 * reason `parseLeadsCsv` validates is that discovering it later means discovering
 * it as a failed send.
 */
function reportRejected(rejected: RejectedRow[]) {
  const listed = rejected
    .slice(0, MAX_LISTED_REJECTS)
    .map((r) => `Row ${r.line}${r.email ? ` (${r.email})` : ""}: ${r.problems.join("; ")}`)

  const remaining = rejected.length - listed.length

  toast.error(
    rejected.length === 1 ? "1 row couldn't be imported" : `${rejected.length} rows couldn't be imported`,
    {
      description: [
        ...listed,
        ...(remaining > 0 ? [`…and ${remaining} more.`] : []),
      ].join("\n"),
      // Longer than the default: this is a list to read, not an acknowledgement.
      duration: 10_000,
    }
  )
}

/**
 * The app's first page — the recipient database. Every row has its own Send
 * button, which is how per-recipient personalization starts.
 */
export function DatabasePage({
  store,
  engagementStore,
  onSend,
  onCancelSchedule,
  onLeadDeleted,
}: DatabasePageProps) {
  const { leads } = store
  const [globalFilter, setGlobalFilter] = useState("")
  const [sorting, setSorting] = useState<SortingState>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  /** The recipient whose schedule is about to be cancelled; null = no dialog. */
  const [cancellingLead, setCancellingLead] = useState<Lead | null>(null)
  /** True while a CSV is being parsed and inserted. */
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function openAdd() {
    setEditingLead(null)
    setDialogOpen(true)
  }

  /**
   * Persist the dialog. Returns whether it landed, so the dialog can stay open on
   * failure — a rejected duplicate shouldn't cost the user their typing.
   *
   * `editingLead` decides insert vs update rather than looking for the id in the
   * list: the dialog no longer invents ids, so a new lead simply has none.
   */
  async function handleSaveLead(lead: NewLead): Promise<boolean> {
    if (editingLead) {
      const saved = await store.update(editingLead.id, lead)
      if (saved) toast.success("Lead updated")
      return saved !== null
    }

    const saved = await store.create(lead)
    if (saved) toast.success("Lead added")
    return saved !== null
  }

  const table = useReactTable({
    data: leads,
    columns: LEAD_COLUMNS,
    state: { globalFilter, sorting },
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    /*
     * Row actions travel as meta so LEAD_COLUMNS can stay a constant. These are
     * re-created every render, but meta isn't part of any memo key, so the cells
     * keep their identity and an in-progress edit holds focus.
     */
    meta: {
      onEditTime: store.setSendTime,
      // Only forget the sequence if the row actually went — see `remove`'s note.
      onDelete: (id) =>
        void store.remove(id).then((deleted) => deleted && onLeadDeleted(id)),
      onEdit: (lead) => {
        setEditingLead(lead)
        setDialogOpen(true)
      },
      onSend,
      // Opens the confirmation rather than cancelling outright — the button sits
      // where Send/Edit/Delete are on every other row, so a stray click would
      // otherwise discard a queued email with no way back to the same send time.
      onCancelSchedule: setCancellingLead,
      engagement: engagementStore.engagement,
    },
  })

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setImporting(true)

    try {
      const { leads: parsed, rejected } = await parseLeadsCsv(file)

      // Rejected rows are reported even when nothing is left to insert — "3 rows
      // were skipped" is the useful half of an import that imported nothing.
      if (rejected.length > 0) reportRejected(rejected)

      if (parsed.length === 0) {
        if (rejected.length === 0) toast.error("That CSV had no rows in it")
        return
      }

      const outcome = await store.importLeads(parsed)
      // null means the insert failed and the store has already said why.
      if (!outcome) return

      if (outcome.inserted === 0) {
        toast.info("Nothing new to import", {
          description: `All ${outcome.duplicates.length} of those addresses were duplicates.`,
        })
        return
      }

      toast.success(`Imported ${outcome.inserted} recipients`, {
        ...(outcome.duplicates.length > 0 && {
          // "duplicate" rather than "already in your database": a file listing the
          // same address twice is skipped here too, and saying otherwise would send
          // the user looking for a row that isn't there.
          description: `Skipped ${outcome.duplicates.length} duplicate ${
            outcome.duplicates.length === 1 ? "address" : "addresses"
          }.`,
        }),
      })
    } catch {
      // Only a failure to *read* the file reaches here — bad rows come back as
      // `rejected` rather than throwing.
      toast.error("Could not parse that CSV file")
    } finally {
      setImporting(false)
      // Cleared so picking the same file again re-fires `change`.
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  function handleExport() {
    const blob = new Blob([leadsToCsv(leads)], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "recipients.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    // Fixed-height column: heading + toolbar stay put and only the table body
    // scrolls, so the page chrome and column headers never scroll away as rows
    // are added.
    <div className="flex min-h-0 w-full flex-1 flex-col px-6 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-foreground">Database</h1>
        <p className="text-sm text-muted-foreground">
          Every recipient gets their own message and send time. Hit{" "}
          <span className="font-medium text-foreground">Send</span> on a row to
          write, preview and launch that one email.
        </p>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {/* Not "0 recipients" while the first read is in flight — that's a
              statement about the database, and it would be wrong. */}
          {store.loading ? "Loading…" : `${leads.length} recipients`}
        </span>
        <div className="relative ml-1 w-72 max-w-full">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search by name, email, company or website…"
            className="h-9 pl-8"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Filter className="size-4" /> Filters
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleImport}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* Disabled until the first read resolves: an import needs the
                  current list to know which addresses are already there. */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={store.loading || importing}
              >
                {importing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {importing ? "Importing…" : "Add recipients"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={openAdd}>
                <UserPlus className="size-4" /> Add one lead
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                <FileUp className="size-4" /> Import from CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={leads.length === 0}
            onClick={handleExport}
          >
            <Upload className="size-4" /> Export
          </Button>
        </div>
      </div>

      {/* Table (scrolls both ways; header row and Actions column stay pinned) */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
        <Table
          containerClassName="h-full overflow-y-auto"
          /*
           * Vertical rules between columns — this table is wide enough to scroll
           * sideways, so the lines are what keep a value tied to its header.
           * Skipped on the last cell: that's the pinned Actions column, whose
           * left edge is already drawn by its own shadow.
           *
           * Body cells only; the header's rules are inset shadows in index.css,
           * since a sticky element's collapsed borders don't paint.
           */
          className="[&_td:not(:last-child)]:border-r"
        >
          <TableHeader className="sticky top-0 z-20">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="pinned-head">
                {hg.headers.map((header) => {
                  const meta = header.column.columnDef.meta
                  return (
                    <TableHead
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      style={meta?.minWidth ? { minWidth: meta.minWidth } : undefined}
                      className={cn(
                        header.column.getCanSort() && "cursor-pointer select-none",
                        // z-30 so the pinned corner cell sits above both the
                        // sticky header row (z-20) and the pinned column (z-10).
                        meta?.sticky && "pinned-col sticky right-0 z-30"
                      )}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="group">
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta
                    return (
                      <TableCell
                        key={cell.id}
                        style={meta?.minWidth ? { minWidth: meta.minWidth } : undefined}
                        className={cn(
                          meta?.sticky && "pinned-cell sticky right-0 z-10"
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={LEAD_COLUMNS.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {/* Three different empty states. "No recipients yet" during the
                      first read would be a claim about the database, and after a
                      search it would be flatly wrong. */}
                  {store.loading ? (
                    <Loader2 className="mx-auto size-4 animate-spin" />
                  ) : globalFilter ? (
                    `No recipients match "${globalFilter}".`
                  ) : (
                    "No recipients yet. Import a CSV to get started."
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <LeadDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        lead={editingLead}
        onSave={handleSaveLead}
      />

      <CancelScheduleDialog
        lead={cancellingLead}
        onOpenChange={(open) => !open && setCancellingLead(null)}
        onConfirm={onCancelSchedule}
      />
    </div>
  )
}
