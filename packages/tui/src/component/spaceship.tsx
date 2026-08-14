import { createEffect, createSignal, createMemo, onCleanup, onMount } from "solid-js"
import { RGBA, StyledText, type BoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { useTheme, tint } from "../context/theme"

const SHIP_COLOR = RGBA.fromInts(0, 209, 209)
const SHIP_GLOW = RGBA.fromInts(0, 255, 183)
const SHIP_ACCENT = RGBA.fromInts(251, 255, 0)
const EXHAUST_INTERVAL = 120
const EXHAUST_CHARS = ["·", "•", "○", "°", "∙"]
const SHIP_ROWS = [
  "    ▲    ",
  "   ╱█╲   ",
  "  ╱███╲  ",
  " ╱█████╲ ",
  "╱███████╲",
  " ██╔═╗██ ",
  " ██║ ║██ ",
  " ╚═╝ ╚═╝ ",
]

const SHIP_WIDTH = 9
const SHIP_HEIGHT = SHIP_ROWS.length

type ExhaustParticle = {
  x: number
  y: number
  life: number
  char: string
}

export function Spaceship(props: { running?: () => boolean }) {
  const { theme } = useTheme()
  const [exhaust, setExhaust] = createSignal<ExhaustParticle[]>([])
  const [pos, setPos] = createSignal({ x: 2, y: 0 })
  const [visible, setVisible] = createSignal(false)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let exhaustTimer: ReturnType<typeof setInterval> | undefined
  let driftTimer: ReturnType<typeof setInterval> | undefined

  const stopExhaust = () => {
    if (exhaustTimer) {
      clearInterval(exhaustTimer)
      exhaustTimer = undefined
    }
    if (driftTimer) {
      clearInterval(driftTimer)
      driftTimer = undefined
    }
  }

  const startExhaust = () => {
    if (exhaustTimer) return
    exhaustTimer = setInterval(() => {
      if (!visible()) return
      const p = pos()
      const particles: ExhaustParticle[] = []
      for (let i = 0; i < 3; i++) {
        particles.push({
          x: p.x + 3 + Math.random() * 3,
          y: p.y + SHIP_HEIGHT + Math.floor(Math.random() * 2),
          life: 4 + Math.floor(Math.random() * 3),
          char: EXHAUST_CHARS[Math.floor(Math.random() * EXHAUST_CHARS.length)],
        })
      }
      setExhaust((prev) => {
        const next = prev
          .map((p) => ({ ...p, life: p.life - 1, y: p.y + 0.3 }))
          .filter((p) => p.life > 0)
        return [...next, ...particles].slice(-20)
      })
    }, EXHAUST_INTERVAL)
    driftTimer = setInterval(() => {
      if (!visible()) return
      setPos((p) => ({
        x: p.x,
        y: p.y + (props.running?.() ? 0 : 0.02),
      }))
    }, 200)
  }

  createEffect(() => {
    if (props.running?.()) {
      setVisible(true)
      startExhaust()
    } else {
      setExhaust([])
      stopExhaust()
    }
  })

  onMount(() => {
    if (props.running?.()) {
      setVisible(true)
      startExhaust()
    }
  })

  onCleanup(() => {
    setVisible(false)
    stopExhaust()
  })

  const content = createMemo(() => {
    const p = pos()
    const chunks: TextChunk[] = []
    const shipMap = new Map<string, { char: string; fg: RGBA }>()

    for (let row = 0; row < SHIP_HEIGHT; row++) {
      const line = SHIP_ROWS[row] ?? ""
      for (let col = 0; col < line.length; col++) {
        const ch = line[col]
        if (!ch || ch === " ") continue
        const key = `${col},${row}`
        let fg = SHIP_COLOR
        if (ch === "▲" || ch === "█" || ch === "╱" || ch === "╲") {
          fg = row < 3 ? SHIP_ACCENT : SHIP_COLOR
        } else if (ch === "╔" || ch === "╗" || ch === "╚" || ch === "╝" || ch === "║" || ch === "═") {
          fg = SHIP_GLOW
        }
        shipMap.set(key, { char: ch, fg })
      }
    }

    for (const ep of exhaust()) {
      const ex = Math.floor(ep.x)
      const ey = Math.floor(ep.y)
      if (ey < 0 || ey > 12) continue
      const alpha = Math.max(0.15, ep.life / 7)
      const color = tint(theme.background, SHIP_GLOW, alpha)
      shipMap.set(`${ex},${ey}`, { char: ep.char, fg: color })
    }

    for (let row = 0; row < 12; row++) {
      for (let col = 0; col < SHIP_WIDTH + 4; col++) {
        const overlay = shipMap.get(`${col},${row}`)
        if (overlay) {
          chunks.push({ __isChunk: true, text: overlay.char, fg: overlay.fg, attributes: 0 })
        } else {
          chunks.push({ __isChunk: true, text: " ", fg: theme.background, attributes: 0 })
        }
      }
      if (row < 11) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }

    return new StyledText(chunks)
  })

  createEffect(() => {
    if (!text) return
    text.content = content()
  })

  return (
    <box
      ref={(item: BoxRenderable) => (box = item)}
      position="absolute"
      bottom={1}
      left={1}
      width={SHIP_WIDTH + 4}
      height={12}
      zIndex={1}
    >
      <text
        ref={(item: TextRenderable) => {
          text = item
          item.content = content()
        }}
        width="100%"
        height="100%"
        wrapMode="none"
        selectable={false}
      />
    </box>
  )
}
