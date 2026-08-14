import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Index, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-task"

const RECENT_DONE_LIMIT = 3

function depthOf(taskId: string): number {
  return taskId.match(/\./g)?.length ?? 0
}

const STATUS_ORDER: Record<string, number> = { in_progress: 0, open: 1, blocked: 2 }

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [doneExpanded, setDoneExpanded] = createSignal(false)
  const theme = () => props.api.theme.current
  const all = createMemo(() => {
    const todo = props.api.state.session.todo(props.session_id)
    return todo
      .filter((t) => t.status !== "completed")
      .map((t, i) => ({
        id: `task.${i}`,
        status: t.status === "in_progress" ? "in_progress" : "open",
        summary: t.content,
      }))
  })
  const done = createMemo(() => {
    const todo = props.api.state.session.todo(props.session_id)
    return todo
      .filter((t) => t.status === "completed")
      .map((t, i) => ({
        id: `task.done.${i}`,
        status: "done" as const,
        summary: t.content,
      }))
  })
  const visibleDone = createMemo(() => (doneExpanded() ? done() : done().slice(0, RECENT_DONE_LIMIT)))
  const hiddenDoneCount = createMemo(() => Math.max(0, done().length - visibleDone().length))
  const rows = createMemo(() => [...active(), ...visibleDone()])
  const show = createMemo(() => rows().length > 0)
  const collapsible = createMemo(() => rows().length + (hiddenDoneCount() > 0 ? 1 : 0) > 2)

  const active = all

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => collapsible() && setOpen((x) => !x)}>
          <Show when={collapsible()}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Tasks</b>
          </text>
        </box>
        <Show when={!collapsible() || open()}>
          <Index each={rows()}>
            {(item) => (
              <TodoItem status={item().status as any} content={item().summary} />
            )}
          </Index>
          <Show when={hiddenDoneCount() > 0 || doneExpanded()}>
            <box flexDirection="row" gap={0} onMouseDown={() => setDoneExpanded((x) => !x)}>
              <text fg={theme().textMuted}>
                {doneExpanded() ? "  ▾ fewer done" : `  ▸ ${hiddenDoneCount()} more done`}
              </text>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
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
