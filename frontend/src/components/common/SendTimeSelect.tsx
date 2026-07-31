import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { sendTimeOptions } from "@/lib/time"

interface SendTimeSelectProps {
  /** The lead's send time as "HH:mm" (IST). */
  value: string
  onChange: (hhmm: string) => void
  /** Set on the trigger so a <Label htmlFor> can point at it. */
  id?: string
  className?: string
}

/**
 * The per-recipient IST send-time picker, shared by the Database table and the
 * compose Content step so both edit the same field through the same control.
 *
 * A dropdown rather than <input type="time">: the native picker is a
 * browser-styled spinner that ignores the app's theme, and its text field
 * clipped the meridiem at the widths this UI has room for.
 */
export function SendTimeSelect({
  value,
  onChange,
  id,
  className,
}: SendTimeSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className={cn("w-28", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {sendTimeOptions(value).map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
