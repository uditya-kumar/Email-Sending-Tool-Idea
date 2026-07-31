import { useRef, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table"
import { FileUp, Filter, Plus, Search, Upload, UserPlus } from "lucide-react"
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
import { useLeadColumns } from "./useLeadColumns"
import { LeadDialog } from "./LeadDialog"
import { leadsToCsv, parseLeadsCsv } from "@/lib/csv"
import type { Lead } from "@/lib/types"

interface DatabasePageProps {
  leads: Lead[]
  onChange: (leads: Lead[]) => void
  /** Opens the per-recipient compose flow (Content → Preview → Launch). */
  onSend: (lead: Lead) => void
  /** Un-schedules a launched recipient, returning them to draft. */
  onCancelSchedule: (lead: Lead) => void
}

/**
 * The app's first page — the recipient database. Every row has its own Send
 * button, which is how per-recipient personalization starts.
 */
export function DatabasePage({
  leads,
  onChange,
  onSend,
  onCancelSchedule,
}: DatabasePageProps) {
  const [globalFilter, setGlobalFilter] = useState("")
  const [sorting, setSorting] = useState<SortingState>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const columns = useLeadColumns({
    onEditTime: (id, value) =>
      onChange(leads.map((l) => (l.id === id ? { ...l, sendTimeIST: value } : l))),
    onDelete: (id) => onChange(leads.filter((l) => l.id !== id)),
    onEdit: (lead) => {
      setEditingLead(lead)
      setDialogOpen(true)
    },
    onSend,
    onCancelSchedule,
  })

  function openAdd() {
    setEditingLead(null)
    setDialogOpen(true)
  }

  function handleSaveLead(lead: Lead) {
    const exists = leads.some((l) => l.id === lead.id)
    if (exists) {
      onChange(leads.map((l) => (l.id === lead.id ? lead : l)))
      toast.success("Lead updated")
    } else {
      onChange([...leads, lead])
      toast.success("Lead added")
    }
  }

  const table = useReactTable({
    data: leads,
    columns,
    state: { globalFilter, sorting },
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await parseLeadsCsv(file)
      onChange([...leads, ...imported])
      toast.success(`Imported ${imported.length} recipients`)
    } catch {
      toast.error("Could not parse that CSV file")
    } finally {
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
          {leads.length} recipients
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
              <Button variant="outline" size="sm" className="gap-1.5">
                <Plus className="size-4" /> Add recipients
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
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExport}>
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
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No recipients yet. Import a CSV to get started.
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
    </div>
  )
}
