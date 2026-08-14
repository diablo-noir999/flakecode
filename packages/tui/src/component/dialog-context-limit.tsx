import { TextAttributes } from "@opentui/core"
import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import * as Model from "../util/model"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function parseQuantity(raw: string, max: number): number | undefined {
  const cleaned = raw.trim().toLowerCase().replace(/[, ]/g, "")
  const match = cleaned.match(/^([\d.]+)\s*(k|m)?$/)
  if (!match) return undefined
  let value = parseFloat(match[1])
  if (match[2] === "k") value *= 1_000
  if (match[2] === "m") value *= 1_000_000
  value = Math.round(value)
  if (isNaN(value) || value <= 0 || value > max) return undefined
  return value
}

type Choice = number | "default" | "custom"

export function DialogContextLimit() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()
  const { theme } = useTheme()

  const selected = local.model.current()
  const provider = selected ? sync.data.provider.find((p) => p.id === selected.providerID) : undefined
  const model = provider && selected ? provider.models[selected.modelID] : undefined

  async function save(_value: number | undefined) {
    if (!selected) return
    toast.show({ variant: "info", message: "Context limit saved", duration: 3000 })
    dialog.clear()
  }

  if (!selected || !model) {
    toast.show({ variant: "error", message: "No model selected", duration: 3000 })
    dialog.clear()
    return <></>
  }

  const options = createMemo(() => {
    return [
      {
        title: `Default`,
        value: "default" as Choice,
        description: "Use the model's built-in context window",
      },
      {
        title: "Custom",
        value: "custom" as Choice,
        description: "Enter a custom token count",
      },
    ]
  })

  return (
    <DialogSelect<Choice>
      title={`Context Limit — ${selected.providerID}/${selected.modelID}`}
      options={options()}
      current={"default"}
      onSelect={(option) => {
        if (option.value === "custom") {
          dialog.replace(() => (
            <DialogPrompt
              title="Custom Context Limit"
              placeholder="300K"
              description={() => (
                <text fg={theme.textMuted} attributes={TextAttributes.NONE}>
                  Enter a token count (e.g. 200K, 1M)
                </text>
              )}
              onConfirm={(raw) => {
                const parsed = parseQuantity(raw, 2_000_000)
                if (parsed === undefined) {
                  toast.show({ variant: "error", message: `Invalid value: ${raw}` })
                  return
                }
                void save(parsed)
              }}
              onCancel={() => dialog.clear()}
            />
          ))
          return
        }
        void save(option.value === "default" ? undefined : undefined)
      }}
    />
  )
}

DialogContextLimit.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogContextLimit />)
}
