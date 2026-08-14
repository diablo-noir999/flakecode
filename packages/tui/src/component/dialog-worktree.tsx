import { createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import path from "path"

const CREATE_SENTINEL = "__create_worktree__"

export function DialogWorktree() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [worktrees, setWorktrees] = createSignal<string[]>()
  const [busy, setBusy] = createSignal<string>()

  onMount(async () => {
    dialog.setSize("medium")
    const result = await sdk.client.worktree.list().catch(() => undefined)
    setWorktrees(result?.data ?? [])
  })

  const options = createMemo(() => {
    const b = busy()
    if (b) {
      return [{ title: b, value: "__busy__" }]
    }

    const list = worktrees()
    if (!list) {
      return [{ title: "Loading worktrees...", value: "__loading__" }]
    }

    const items = list.map((dir) => ({
      title: path.basename(dir),
      value: dir,
      description: dir,
    }))

    return [
      ...items,
      {
        title: "+ Create new worktree",
        value: CREATE_SENTINEL,
        description: undefined as string | undefined,
      },
    ]
  })

  async function create() {
    setBusy("Creating worktree...")
    const result = await sdk.client.worktree.create().catch(() => undefined)
    if (!result?.data) {
      toast.show({ message: "Failed to create worktree", variant: "error" })
      setBusy(undefined)
      return
    }
    toast.show({ message: `Created worktree: ${path.basename(result.data.directory)}`, variant: "success" })
    setBusy(undefined)
    dialog.clear()
  }

  return (
    <DialogSelect
      title="Worktrees"
      options={options()}
      skipFilter={true}
      onSelect={(option) => {
        if (option.value === "__busy__" || option.value === "__loading__") return
        if (option.value === CREATE_SENTINEL) {
          void create()
          return
        }
        toast.show({ message: `Selected: ${path.basename(option.value)}`, variant: "info" })
        dialog.clear()
      }}
    />
  )
}
