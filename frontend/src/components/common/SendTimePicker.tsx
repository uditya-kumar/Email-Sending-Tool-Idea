import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface SendTimePickerProps {
  /** The lead's send time as "HH:mm" (IST). */
  value: string
  onChange: (hhmm: string) => void
  /** Set on the input so a <Label htmlFor> can point at it. */
  id?: string
  className?: string
}

/**
 * The per-recipient IST send-time picker, shared by the Database table, the lead
 * dialog and the compose Content step so all three edit the same field through
 * the same control.
 *
 * A native time input: its value is always "HH:mm" in 24-hour form no matter how
 * the browser renders it, which is exactly what a lead stores, and any minute is
 * typable rather than only the quarter-hours a dropdown could list.
 */
export function SendTimePicker({
  value,
  onChange,
  id,
  className,
}: SendTimePickerProps) {
  return (
    <Input
      type="time"
      id={id}
      value={value}
      // A half-entered time reads as "" — ignore those so a lead can't lose its
      // send time mid-edit. It's required, so there's no clearing it either.
      onChange={(e) => e.target.value && onChange(e.target.value)}
      aria-label="Send time (IST)"
      className={cn(
        // The browser's own clock button is hidden (shadcn's pattern): it's
        // unthemed, and the field is editable by typing or arrow keys without it.
        "w-32 appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none",
        className
      )}
    />
  )
}
