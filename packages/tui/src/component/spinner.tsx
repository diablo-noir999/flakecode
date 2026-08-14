import { createMemo } from "solid-js"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { registerFlakecodeSpinner } from "./register-spinner"
import { createFrames, createColors } from "../ui/spinner"

registerFlakecodeSpinner()

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted

  const knightRiderDef = createMemo(() => {
    const frames = createFrames({
      color: color(),
      style: "plane",
      width: 14,
      holdStart: 8,
      holdEnd: 8,
      inactiveFactor: 0.6,
      minAlpha: 0.3,
    })
    const colors = createColors({
      color: color(),
      style: "plane",
      width: 14,
      holdStart: 8,
      holdEnd: 8,
      inactiveFactor: 0.6,
      minAlpha: 0.3,
    })
    return { frames, colors }
  })

  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={knightRiderDef().frames} color={knightRiderDef().colors} interval={40} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
