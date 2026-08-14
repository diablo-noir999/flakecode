import { TextAttributes } from "@opentui/core"
import open from "open"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog, type DialogContext } from "../ui/dialog"

const TOKEN_PLAN_URL = "https://platform.xiaomimimo.com/token-plan"

export function DialogTokenPlan(props: { onClose?: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const toast = useToast()

  const close = () => {
    dialog.clear()
    props.onClose?.()
  }

  const openLink = () => {
    open(TOKEN_PLAN_URL).catch(() => {
      toast.show({ message: TOKEN_PLAN_URL, variant: "info" })
    })
  }

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") close()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Token Plan
        </text>
        <text fg={theme.textMuted} onMouseUp={() => close()}>
          [close]
        </text>
      </box>
      <box gap={0} paddingBottom={1}>
        <text fg={theme.textMuted}>You have reached the free tier limit.</text>
        <box flexDirection="row" flexWrap="wrap">
          <text fg={theme.textMuted}>Subscribe at </text>
          <text
            fg={theme.primary}
            attributes={TextAttributes.UNDERLINE}
            onMouseUp={() => openLink()}
          >
            {TOKEN_PLAN_URL}
          </text>
          <text fg={theme.textMuted}> for higher limits.</text>
        </box>
      </box>
      <box flexDirection="row" justifyContent="center" paddingBottom={1}>
        <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={() => close()}>
          <text fg={theme.selectedListItemText}>OK</text>
        </box>
      </box>
    </box>
  )
}

DialogTokenPlan.show = (dialog: DialogContext) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogTokenPlan onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
