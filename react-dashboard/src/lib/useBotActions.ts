import { useMutation, useQueryClient } from "@tanstack/react-query"
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
 * Runs a bot control action (stop / archive / remove / delete) and auto-refreshes
 * the affected TanStack Query caches on success — immediately, then again after a
 * short delay to catch the docker daemon / archiver catching up server-side.
 */
export function useBotActions() {
  const qc = useQueryClient()

  const refresh = () => {
    for (const key of AFFECTED_KEYS) {
      qc.invalidateQueries({ queryKey: [key] })
    }
  }

  const mutation = useMutation({
    mutationFn: ({ fn }: { label: string; fn: () => Promise<unknown> }) => fn(),
    onSuccess: (_data, vars) => {
      toast.success(`${vars.label} succeeded`)
      refresh()
      // Container stop/remove and DB archiving lag a moment on the server.
      setTimeout(refresh, 1_500)
      setTimeout(refresh, 4_000)
    },
    onError: (e, vars) => toast.error(`${vars.label} failed: ${(e as Error).message}`),
  })

  return {
    isPending: mutation.isPending,
    act: (label: string, fn: () => Promise<unknown>) => mutation.mutate({ label, fn }),
  }
}
