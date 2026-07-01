import * as React from "react"
import { useIsFetching, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

// Queries that should refetch after any bot control action.
const AFFECTED_KEYS = [
  "activeContainers",
  "exitedContainers",
  "allBotsStatus",
  "archivedBots",
  "controllerPerfLatest",
  "portfolio",
]

/**
 * Runs bot control actions (stop / archive / remove / delete) and auto-refreshes
 * the affected TanStack Query caches on success — immediately, then again after a
 * short delay to catch the docker daemon / archiver catching up server-side.
 *
 * Loading state is tracked PER ACTION (keyed by label) so only the button you
 * clicked shows a spinner — not every control on the page. `isRefreshing` reports
 * whether any affected query is currently refetching, so the list can show a
 * subtle "updating…" hint after the action returns.
 */
export function useBotActions() {
  const qc = useQueryClient()
  const [pending, setPending] = React.useState<Set<string>>(new Set())
  const refetching = useIsFetching({
    predicate: (q) => AFFECTED_KEYS.includes(q.queryKey[0] as string),
  })

  const refresh = React.useCallback(() => {
    for (const key of AFFECTED_KEYS) qc.invalidateQueries({ queryKey: [key] })
  }, [qc])

  const act = React.useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setPending((p) => new Set(p).add(label))
      try {
        await fn()
        toast.success(`${label} succeeded`)
        refresh()
        // Container stop/remove and DB archiving lag a moment on the server.
        setTimeout(refresh, 1_500)
        setTimeout(refresh, 4_000)
      } catch (e) {
        toast.error(`${label} failed: ${(e as Error).message}`)
      } finally {
        setPending((p) => {
          const next = new Set(p)
          next.delete(label)
          return next
        })
      }
    },
    [refresh],
  )

  return {
    act,
    /** True while ANY action is running (use for coarse guards). */
    isPending: pending.size > 0,
    /** True while the given labelled action is running. */
    isActing: (label: string) => pending.has(label),
    /** True while affected queries are refetching after an action. */
    isRefreshing: refetching > 0,
  }
}
