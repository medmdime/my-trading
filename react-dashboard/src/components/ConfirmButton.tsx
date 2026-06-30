import * as React from "react"

import { IS_LIVE } from "@/lib/env"
import { Button } from "@/components/ui/button"
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

interface ConfirmButtonProps {
  label: string
  title: string
  /** Optional subject (e.g. a long bot name) rendered on its own wrapping line. */
  name?: string
  description: React.ReactNode
  confirmLabel?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  disabled?: boolean
  onConfirm: () => void
  /** Force the dialog even when not pointed at live prod. */
  alwaysConfirm?: boolean
}

/**
 * A button that pops a confirm dialog before running a control action.
 * On live prod (or alwaysConfirm) the dialog is shown; otherwise it runs directly.
 */
export function ConfirmButton({
  label,
  title,
  name,
  description,
  confirmLabel = "Confirm",
  variant = "outline",
  size = "sm",
  disabled,
  onConfirm,
  alwaysConfirm,
}: ConfirmButtonProps) {
  const [open, setOpen] = React.useState(false)
  const needsConfirm = IS_LIVE || alwaysConfirm

  if (!needsConfirm) {
    return (
      <Button variant={variant} size={size} disabled={disabled} onClick={onConfirm}>
        {label}
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-8 break-words">{title}</DialogTitle>
          <DialogDescription className="break-words">{description}</DialogDescription>
        </DialogHeader>
        {name && (
          <div className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
            {name}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant={variant === "outline" ? "destructive" : variant}
            size="sm"
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
