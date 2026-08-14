import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-goal"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const goal = createMemo(() => (session() as any)?.goal)

  const show = createMemo(() => Boolean(goal()?.condition))

  const status = createMemo(() => {
    const g = goal()
    if (!g) return undefined
    if (g.ok) return { dot: theme().success, label: "met" }
    if (g.impossible) return { dot: theme().error, label: "impossible" }
    if (g.attempt) return { dot: theme().warning, label: `round ${g.attempt} · not met` }
    return undefined
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>Goal</b>
          </text>
        </box>
        <Show when={goal()?.condition}>
          {(condition) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme().primary}>
                •
              </text>
              <text fg={theme().textMuted} wrapMode="word">
                {condition()}
              </text>
            </box>
          )}
        </Show>
        <Show when={status()}>
          {(s) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={s().dot}>
                •
              </text>
              <text fg={theme().textMuted} wrapMode="word">
                Judge: {s().label}
              </text>
            </box>
          )}
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
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
