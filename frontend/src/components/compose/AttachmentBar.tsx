import { useRef, useState } from "react"
import { Loader2, Paperclip, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { attachmentDownloadUrl } from "@/lib/attachments"
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  checkAttachment,
  formatAttachmentSize,
} from "@shared/attachments.ts"
import type { StepAttachment } from "@/lib/types"

interface AttachmentBarProps {
  /**
   * The step's files, or undefined while the sequence is still loading.
   *
   * The distinction matters: an empty array renders "no attachments", which would
   * be a lie during the read and could prompt the user to re-upload a file that is
   * already there.
   */
  attachments?: StepAttachment[] | undefined
  onAttach: (file: File) => Promise<void>
  onDetach: (attachment: StepAttachment) => Promise<void>
  /** Attaching is blocked while a structural save is in flight — ids may change. */
  disabled?: boolean | undefined
}

/**
 * The attachment row under the email body: what's attached, plus a control to add
 * a file.
 *
 * Files are uploaded one at a time even though the picker allows a multi-select,
 * because the size limit applies to the step's running total — attaching four
 * files in parallel would each check against the same stale total and collectively
 * pass a limit none of them individually broke.
 */
export function AttachmentBar({
  attachments,
  onAttach,
  onDetach,
  disabled,
}: AttachmentBarProps) {
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  /** Ids currently being removed — the row stays visible but goes quiet. */
  const [removing, setRemoving] = useState<string[]>([])

  const files = attachments ?? []
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const busy = uploading || disabled === true

  async function handleFiles(chosen: File[]) {
    setUploading(true)

    /*
     * `running` mirrors the total the store will see, so the second file of a
     * multi-select is checked against the first having landed. Rejections are
     * reported and the loop continues: one oversized file among three shouldn't
     * silently drop the two that fit.
     */
    let running = totalBytes

    for (const file of chosen) {
      const check = checkAttachment(file, running)
      if (!check.ok) {
        toast.error(`Couldn't attach ${file.name}`, { description: check.reason })
        continue
      }

      try {
        await onAttach(file)
        running += file.size
      } catch (error) {
        toast.error(`Couldn't attach ${file.name}`, {
          description: error instanceof Error ? error.message : "Something went wrong.",
        })
      }
    }

    setUploading(false)
  }

  async function handleDetach(attachment: StepAttachment) {
    setRemoving((prev) => [...prev, attachment.id])

    try {
      await onDetach(attachment)
    } catch (error) {
      toast.error(`Couldn't remove ${attachment.filename}`, {
        description: error instanceof Error ? error.message : "Something went wrong.",
      })
    } finally {
      setRemoving((prev) => prev.filter((id) => id !== attachment.id))
    }
  }

  /** Open the stored file in a new tab, so the user can check what they attached. */
  async function preview(attachment: StepAttachment) {
    try {
      // Signed on demand rather than held on the row: the URL expires in a minute,
      // and one minted at load time would be dead by the time it's clicked.
      window.open(await attachmentDownloadUrl(attachment), "_blank", "noopener")
    } catch (error) {
      toast.error("Couldn't open that file", {
        description: error instanceof Error ? error.message : "Something went wrong.",
      })
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />

      {files.map((file) => {
        const pending = removing.includes(file.id)

        return (
          <span
            key={file.id}
            className="flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 py-1 pr-1 pl-2 text-xs"
          >
            <button
              type="button"
              onClick={() => void preview(file)}
              className="truncate font-medium text-foreground hover:underline"
              title={file.filename}
            >
              {file.filename}
            </button>
            <span className="shrink-0 text-muted-foreground">
              {formatAttachmentSize(file.sizeBytes)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void handleDetach(file)}
              disabled={pending}
              aria-label={`Remove ${file.filename}`}
            >
              {pending ? <Loader2 className="animate-spin" /> : <X />}
            </Button>
          </span>
        )
      })}

      {/*
        Hidden native input rather than a styled `<input type="file">`: the file
        picker cannot be opened without one, and its own rendering can't be themed.
      */}
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])]
          // Cleared before the upload, not after: picking the same file twice in a
          // row fires no change event while the old value is still set.
          e.target.value = ""
          if (chosen.length > 0) void handleFiles(chosen)
        }}
      />

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="h-7 text-xs text-muted-foreground"
      >
        {uploading ? <Loader2 className="animate-spin" /> : <Plus />}
        {uploading ? "Uploading…" : files.length > 0 ? "Add file" : "Attach a file"}
      </Button>

      {files.length === 0 && !uploading && (
        <span className="text-xs text-muted-foreground">
          PDF or Word, up to {formatAttachmentSize(MAX_ATTACHMENT_BYTES)}
        </span>
      )}
    </div>
  )
}
