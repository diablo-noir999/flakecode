import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { Global } from "@opencode-ai/core/global"

const id = "internal:sidebar-cwd"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const projectDir = createMemo(() => props.api.state.path.directory)
  const display = createMemo(() => {
    const dir = session()?.directory || projectDir()
    if (!dir) return ""
    return dir.replace(Global.Path.home, "~")
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>CWD</b>
      </text>
      <text fg={theme().textMuted}>{display()}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
