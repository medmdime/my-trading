import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { KeyRound, Loader2, Plus, ShieldCheck } from "lucide-react"

import {
  addAccount,
  addCredential,
  deleteAccount,
  deleteCredential,
  getAccountCredentials,
  getAccounts,
  getAvailableConnectors,
  getConnectorConfigMap,
} from "@/lib/api"
import { ApiError } from "@/lib/api"
import { ConfirmButton } from "@/components/ConfirmButton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

const MASTER = "master_account"

export function Accounts() {
  const qc = useQueryClient()
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts })
  const [selected, setSelected] = React.useState<string>(MASTER)

  React.useEffect(() => {
    const list = accounts.data ?? []
    if (list.length > 0 && !list.includes(selected)) setSelected(list[0])
  }, [accounts.data, selected])

  const hasMaster = (accounts.data ?? []).includes(MASTER)

  const createAccount = useMutation({
    mutationFn: (name: string) => addAccount(name),
    onSuccess: (_r, name) => {
      toast.success(`Account "${name}" created`)
      setSelected(name)
      qc.invalidateQueries({ queryKey: ["accounts"] })
    },
    onError: (e) => toast.error(`Create account failed: ${(e as Error).message}`),
  })

  const removeAccount = useMutation({
    mutationFn: (name: string) => deleteAccount(name),
    onSuccess: (_r, name) => {
      toast.success(`Account "${name}" deleted`)
      if (selected === name) setSelected(MASTER)
      qc.invalidateQueries({ queryKey: ["accounts"] })
    },
    onError: (e) => toast.error(`Delete account failed: ${(e as Error).message}`),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Exchange API keys live only on this server, in <code className="text-xs">bots/credentials/</code>
          {" "}— never in git, never in the browser bundle.{" "}
          <code className="text-xs">{MASTER}</code> is the default account bots deploy against.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Accounts ({accounts.data?.length ?? 0})</CardTitle>
          <div className="flex items-center gap-2">
            {!hasMaster && !accounts.isLoading && (
              <Button
                size="sm"
                onClick={() => createAccount.mutate(MASTER)}
                disabled={createAccount.isPending}
              >
                {createAccount.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="size-3.5" />
                )}
                Create master account
              </Button>
            )}
            <NewAccountDialog
              onCreate={(name) => createAccount.mutate(name)}
              loading={createAccount.isPending}
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {accounts.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!accounts.isLoading && (accounts.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No accounts yet — create your master account to get started.
            </p>
          )}
          {(accounts.data ?? []).map((name) => (
            <button
              key={name}
              onClick={() => setSelected(name)}
              className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
                selected === name
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              }`}
            >
              {name === MASTER && <ShieldCheck className="mr-1 inline size-3" />}
              {name}
            </button>
          ))}
        </CardContent>
      </Card>

      {selected && (
        <CredentialsCard
          account={selected}
          onDeleteAccount={
            selected === MASTER ? undefined : () => removeAccount.mutate(selected)
          }
          deletingAccount={removeAccount.isPending}
        />
      )}
    </div>
  )
}

function NewAccountDialog({
  onCreate,
  loading,
}: {
  onCreate: (name: string) => void
  loading: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="size-3.5" />
          New account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new account</DialogTitle>
          <DialogDescription>
            Copies master_account's default config files into a new, isolated credentials
            profile. Add its own connector API keys afterward.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="account name, e.g. sub_account_1"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={!name.trim() || loading}
            onClick={() => {
              onCreate(name.trim())
              setOpen(false)
              setName("")
            }}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CredentialsCard({
  account,
  onDeleteAccount,
  deletingAccount,
}: {
  account: string
  onDeleteAccount?: () => void
  deletingAccount: boolean
}) {
  const qc = useQueryClient()
  const creds = useQuery({
    queryKey: ["accountCredentials", account],
    queryFn: () => getAccountCredentials(account),
  })

  const removeCred = useMutation({
    mutationFn: (connector: string) => deleteCredential(account, connector),
    onSuccess: (_r, connector) => {
      toast.success(`Removed ${connector} credentials from ${account}`)
      qc.invalidateQueries({ queryKey: ["accountCredentials", account] })
    },
    onError: (e) => toast.error(`Delete credential failed: ${(e as Error).message}`),
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 font-mono text-sm">
          <KeyRound className="size-4" />
          {account}
        </CardTitle>
        <div className="flex items-center gap-2">
          <AddCredentialDialog account={account} />
          {onDeleteAccount && (
            <ConfirmButton
              label="Delete account"
              title="Delete this account?"
              name={account}
              description="Permanently deletes this account's folder and every connector credential in it. This cannot be undone."
              confirmLabel="Delete account"
              alwaysConfirm
              loading={deletingAccount}
              onConfirm={onDeleteAccount}
            />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {creds.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!creds.isLoading && (creds.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">
            No connector credentials added yet. Click "Add credential" to connect an exchange.
          </p>
        )}
        {(creds.data ?? []).map((connector) => (
          <div key={connector} className="flex items-center gap-2 rounded-md border p-3">
            <Badge className="bg-emerald-600 text-white">connected</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{connector}</span>
            <ConfirmButton
              label="Remove"
              title="Remove this credential?"
              name={`${account} · ${connector}`}
              description="Deletes the stored API key/secret for this connector. Any bot using it will fail to start until it's re-added."
              confirmLabel="Remove"
              alwaysConfirm
              loading={removeCred.isPending}
              onConfirm={() => removeCred.mutate(connector)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function AddCredentialDialog({ account }: { account: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [connector, setConnector] = React.useState("")
  const [fields, setFields] = React.useState<Record<string, string>>({})

  const connectors = useQuery({
    queryKey: ["availableConnectors"],
    queryFn: getAvailableConnectors,
    enabled: open,
    staleTime: 10 * 60_000,
  })
  const configMap = useQuery({
    queryKey: ["connectorConfigMap", connector],
    queryFn: () => getConnectorConfigMap(connector),
    enabled: open && !!connector,
  })

  React.useEffect(() => {
    setFields({})
  }, [connector])

  const save = useMutation({
    mutationFn: () => addCredential(account, connector, fields),
    onSuccess: () => {
      toast.success(`Added ${connector} credentials to ${account}`)
      qc.invalidateQueries({ queryKey: ["accountCredentials", account] })
      setOpen(false)
      setConnector("")
      setFields({})
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.body : (e as Error).message
      toast.error(`Add credential failed: ${msg}`)
    },
  })

  const requiredFields = Object.entries(configMap.data ?? {})
  const canSave =
    connector !== "" &&
    requiredFields.every(([key, f]) => !f.required || (fields[key] ?? "").trim() !== "")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          Add credential
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add connector credentials — {account}</DialogTitle>
          <DialogDescription>
            Stored encrypted on the server (never sent anywhere else, never committed to git).
          </DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Connector</span>
          <select
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={connector}
            onChange={(e) => setConnector(e.target.value)}
          >
            <option value="">Select a connector…</option>
            {(connectors.data ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        {connector && configMap.isLoading && (
          <p className="text-sm text-muted-foreground">Loading required fields…</p>
        )}

        {connector && !configMap.isLoading && requiredFields.length > 0 && (
          <div className="grid gap-3">
            {requiredFields.map(([key, f]) => (
              <label key={key} className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  {key}
                  {f.required && <span className="text-destructive"> *</span>}
                  <span className="ml-1 text-[10px] opacity-60">({f.type})</span>
                </span>
                {f.allowed_values ? (
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={fields[key] ?? ""}
                    onChange={(e) => setFields((s) => ({ ...s, [key]: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {f.allowed_values.map((v) => (
                      <option key={String(v)} value={String(v)}>
                        {String(v)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    className="h-9"
                    type={f.type === "SecretStr" ? "password" : "text"}
                    autoComplete="off"
                    value={fields[key] ?? ""}
                    onChange={(e) => setFields((s) => ({ ...s, [key]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save credential
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
