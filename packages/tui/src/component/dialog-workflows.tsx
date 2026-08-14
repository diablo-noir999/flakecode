import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

export function DialogWorkflows() {
  const dialog = useDialog()

  const options: DialogSelectOption<string>[] = [
    { title: "(no workflow runs)", value: "empty", onSelect: (d) => d.clear() },
  ]

  return <DialogSelect title="Workflows" options={options} />
}
