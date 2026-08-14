import type { ParsedKey } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import { createStore } from "solid-js/store"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { useTuiConfig } from "../config"
import { TuiKeybind } from "../config/keybind"

export type PluginKeybindMap = Record<string, string>

type Base = {
  match: (key: string, evt: ParsedKey) => boolean
  print: (key: string) => string
}

export type PluginKeybind = {
  readonly all: PluginKeybindMap
  get: (name: string) => string
  match: (name: string, evt: ParsedKey) => boolean
  print: (name: string) => string
}

export const { use: useKeybind, provider: KeybindProvider } = createSimpleContext({
  name: "Keybind",
  init: () => {
    const config = useTuiConfig()
    const [store, setStore] = createStore({
      leader: false,
    })
    const renderer = useRenderer()

    let focus: any | null
    let timeout: NodeJS.Timeout
    function leader(active: boolean) {
      if (active) {
        setStore("leader", true)
        focus = renderer.currentFocusedRenderable
        focus?.blur()
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() => {
          if (!store.leader) return
          leader(false)
          if (!focus || focus.isDestroyed) return
          focus.focus()
        }, 2000)
        return
      }

      if (!active) {
        if (focus && !renderer.currentFocusedRenderable) {
          focus.focus()
        }
        setStore("leader", false)
      }
    }

    useKeyboard(async (evt) => {
      if (!store.leader && result.match("leader", evt)) {
        leader(true)
        return
      }

      if (store.leader && evt.name) {
        setImmediate(() => {
          if (focus && renderer.currentFocusedRenderable === focus) {
            focus.focus()
          }
          leader(false)
        })
      }
    })

    const result = {
      get leader() {
        return store.leader
      },
      parse(_evt: ParsedKey): string {
        return ""
      },
      match(key: string, evt: ParsedKey) {
        if (key === "leader") {
          const leaderConfig = (config.keybinds as Record<string, unknown>)?.leader
          if (typeof leaderConfig === "string" && leaderConfig) {
            return evt.name === leaderConfig.split("+").pop()
          }
          return false
        }
        return false
      },
      print(key: string) {
        const keybinds = config.keybinds as unknown as Record<string, string> | undefined
        const value = keybinds?.[key]
        return value ?? key
      },
    }
    return result
  },
})

export function createPluginKeybind(
  base: { match: (key: string, evt: ParsedKey) => boolean; print: (key: string) => string },
  defaults: PluginKeybindMap,
  overrides?: Record<string, unknown>,
): PluginKeybind {
  const all = Object.freeze(
    Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, (typeof overrides?.[name] === "string" ? overrides[name] : value) ?? value])),
  )
  const get = (name: string) => all[name] ?? name

  return {
    get all() {
      return all
    },
    get,
    match: (name, evt) => base.match(get(name), evt),
    print: (name) => base.print(get(name)),
  }
}
