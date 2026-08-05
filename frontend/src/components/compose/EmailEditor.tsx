import { useState } from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import Placeholder from "@tiptap/extension-placeholder"
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  Link as LinkIcon,
  Braces,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { countWords } from "@/lib/text"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { InsertAttributeDialog } from "./InsertAttributeDialog"
import { MergeTagHighlight } from "./merge-tag-highlight"

interface EmailEditorProps {
  bodyHtml: string
  onChange: (html: string) => void
  /**
   * Where "Insert attribute" should put the tag.
   *
   * The button lives in this toolbar but the subject line does not, so the caller —
   * which owns both fields — says which one the caret was last in. `"subject"` hands
   * the tag to `onInsertOutside` instead of dropping it into the body, which is what
   * a user who clicked into Subject and then hit the button is asking for.
   */
  insertTarget?: "body" | "subject" | undefined
  /** Receives the tag when `insertTarget` isn't the body. */
  onInsertOutside?: ((tag: string) => void) | undefined
  /** The body took focus — the caller tracks this to resolve `insertTarget`. */
  onBodyFocus?: (() => void) | undefined
}

/** One icon button in the formatting toolbar; highlighted while its mark is on. */
function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={onClick}
      className={cn(active && "bg-muted text-foreground")}
    >
      {children}
    </Button>
  )
}

/** Rich-text email body editor (Tiptap) with a Hunter-style toolbar + footer. */
export function EmailEditor({
  bodyHtml,
  onChange,
  insertTarget = "body",
  onInsertOutside,
  onBodyFocus,
}: EmailEditorProps) {
  const [attrOpen, setAttrOpen] = useState(false)
  const [words, setWords] = useState(0)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: "Compose your email" }),
      // Greys out {{merge_tags}} without turning them into un-editable atoms.
      MergeTagHighlight,
    ],
    content: bodyHtml || "",
    // Seed the initial count once the editor mounts with existing content.
    onCreate: ({ editor }) => setWords(countWords(editor.getText())),
    // Told to the caller rather than tracked here, because the thing it decides —
    // body or subject — is a question only the caller can answer.
    onFocus: () => onBodyFocus?.(),
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
      setWords(countWords(editor.getText()))
    },
    editorProps: {
      attributes: { class: "px-4 py-3" },
    },
  })

  if (!editor) return null

  function insertTag(tag: string) {
    /*
     * Route to the subject when that is where the caret was. Without this the tag
     * always landed in the body, so clicking into Subject and reaching for the
     * button put `{{first_name}}` in the message instead of the subject line — and
     * then needed deleting from one field and retyping into the other.
     */
    if (insertTarget !== "body" && onInsertOutside) {
      onInsertOutside(tag)
      return
    }
    editor?.chain().focus().insertContent(`${tag} `).run()
  }

  function toggleLink() {
    const prev = editor?.getAttributes("link").href as string | undefined
    const url = window.prompt("Link URL", prev ?? "https://")
    if (url === null) return
    if (url === "") {
      editor?.chain().focus().extendMarkRange("link").unsetLink().run()
      return
    }
    editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
  }

  return (
    <div className="flex flex-col">
      <div className="min-h-[240px]">
        <EditorContent editor={editor} />
      </div>

      {/* Formatting toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-t px-3 py-1.5">
        <ToolbarButton
          label="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic />
        </ToolbarButton>
        <ToolbarButton
          label="Strikethrough"
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough />
        </ToolbarButton>
        <ToolbarButton
          label="Bullet list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered />
        </ToolbarButton>
        <ToolbarButton label="Link" active={editor.isActive("link")} onClick={toggleLink}>
          <LinkIcon />
        </ToolbarButton>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setAttrOpen(true)}
        >
          <Braces className="size-3.5" /> Insert attribute
        </Button>
      </div>

      {/* Footer stats */}
      <div className="flex items-center border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        <span>
          Words: <span className="font-medium text-foreground">{words}</span>
        </span>
      </div>

      <InsertAttributeDialog
        open={attrOpen}
        onOpenChange={setAttrOpen}
        onInsert={insertTag}
      />
    </div>
  )
}
