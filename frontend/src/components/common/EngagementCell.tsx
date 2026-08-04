import { Eye, MousePointerClick } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatISTDateTime } from "@/lib/time"
import { cn } from "@/lib/utils"
import type { LeadEngagement } from "@/lib/types"

interface EngagementCellProps {
  /**
   * This lead's counts, or undefined when they have no sends yet.
   *
   * The distinction matters: "0 opens" is a claim about an email that went out,
   * and making it about a draft would be wrong. See `EngagementStore.engagement`.
   */
  engagement: LeadEngagement | undefined
}

/**
 * One open, which is the ambiguous case.
 *
 * Apple Mail Privacy Protection fetches the pixel before a person has looked at
 * anything, so a single open is closer to "delivered" than to "read". A second
 * fetch means somebody came back to the message, and that is the threshold the
 * colouring uses.
 */
const REPEAT_OPEN_THRESHOLD = 2

/**
 * A recipient's opens and clicks, as counts.
 *
 * Counts rather than a "Opened" badge because the number is the signal: the whole
 * reason to show two is that one open is unreliable (see above) while a second one
 * is not, and three clicks is a warmer lead than one. Clicks are never deduplicated
 * anywhere in the stack — a second click is a real second click — so they read at
 * face value, which is why any click at all is coloured.
 *
 * `opens` is reads, not pixel fetches: a thread with three follow-ups in it fetches
 * three pixels per read, and `lead_engagement` collapses those back into one. So
 * the number here does not grow just because the sequence got longer.
 */
export function EngagementCell({ engagement }: EngagementCellProps) {
  if (!engagement) {
    return (
      <span className="text-muted-foreground" title="Nothing sent to this recipient yet">
        —
      </span>
    )
  }

  const { opens, proxyOpens, clicks, distinctLinks, lastOpenAt, lastClickAt } = engagement

  const repeatOpened = opens >= REPEAT_OPEN_THRESHOLD
  /*
   * Only mentioned on the ambiguous single open. Gmail routes every image through
   * its proxy — including the fetch a human opening the message causes — so this
   * being true says nothing on its own; it's the *one open* that's uncertain, and
   * only then is the delivery-prefetch possibility worth raising.
   */
  const viaProxy = proxyOpens > 0

  return (
    // One provider per cell rather than one at the app root, so this component is
    // droppable anywhere without a setup step. It holds only context and the
    // skip-delay timer, so the cost is a closure per row.
    <TooltipProvider>
      <div className="flex items-center gap-3 whitespace-nowrap">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-sm tabular-nums",
                repeatOpened
                  ? "font-medium text-success"
                  : opens > 0
                    ? "text-foreground"
                    : "text-muted-foreground"
              )}
            >
              <Eye className="size-3.5" />
              {opens}
            </span>
          </TooltipTrigger>
          <TooltipContent className="block max-w-xs">
            {opens === 0 ? (
              <>
                No opens recorded — the email is delivered but nothing has fetched
                its pixel. Only emails sent with open tracking on are counted, and
                a recipient with images blocked never registers one.
              </>
            ) : repeatOpened ? (
              <>
                Opened {opens} separate times — a repeat read, so this is a person
                rather than an automatic image prefetch.
              </>
            ) : viaProxy ? (
              <>
                Opened once, through the recipient's mail provider image proxy.
                Probably a real read — Gmail loads images when the message is
                opened — but a provider that pre-loads on delivery (Apple Mail
                Privacy Protection) looks identical from here. A second open would
                settle it.
              </>
            ) : (
              <>
                Opened once, fetched directly by the mail client rather than a
                proxy. A second open would confirm a repeat read.
              </>
            )}
            {lastOpenAt && (
              <div className="mt-1 opacity-80">Last: {formatISTDateTime(lastOpenAt)}</div>
            )}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-sm tabular-nums",
                clicks > 0 ? "font-medium text-accent" : "text-muted-foreground"
              )}
            >
              <MousePointerClick className="size-3.5" />
              {clicks}
            </span>
          </TooltipTrigger>
          <TooltipContent className="block max-w-xs">
            {clicks === 0 ? (
              <>
                No clicks. Only links in emails sent with click tracking on are
                counted.
              </>
            ) : (
              <>
                {clicks} {clicks === 1 ? "click" : "clicks"}
                {/*
                 * Distinct links only once they add something: with a single link
                 * clicked repeatedly the pair "3 clicks / 1 link" is the useful
                 * reading, while "1 click / 1 link" is noise.
                 */}
                {distinctLinks > 1 && ` across ${distinctLinks} different links`}. A
                click is a real action, unlike an open — nothing prefetches these.
              </>
            )}
            {lastClickAt && (
              <div className="mt-1 opacity-80">Last: {formatISTDateTime(lastClickAt)}</div>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
