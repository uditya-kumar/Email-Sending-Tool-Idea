"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      /*
       * Pinned to light because the app itself is light-only (nothing ever sets
       * the `.dark` class). Sonner's default "system" theme follows the OS, so
       * on a dark-mode machine it painted dark-theme text — near-white
       * descriptions on a white toast.
       */
      theme="light"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      // Every toast gets a dismiss (X) button.
      closeButton
      toastOptions={{
        classNames: {
          // Room on the right so content never runs under the close button.
          toast: "cn-toast !pr-10",
          // Sonner hardcodes #3f3f3f here; use our own muted token instead.
          description: "!text-muted-foreground",
          /*
           * Sonner parks the close button outside the top-left corner and
           * colors it with --gray4/--gray12 (undefined in this theme). Pull it
           * inside the toast, vertically centred against the right edge, and
           * map the colors to our tokens. `transform-none` clears sonner's
           * translate(-35%,-35%) nudge; centring uses -mt (half of size-5)
           * because Tailwind's translate utilities write to a different
           * property and wouldn't override it.
           */
          closeButton:
            "!top-1/2 !right-3 !left-auto !-mt-2.5 !size-5 !transform-none !border-transparent !bg-transparent !text-muted-foreground hover:!bg-muted hover:!text-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
