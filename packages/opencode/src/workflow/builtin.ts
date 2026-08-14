export * as BuiltinWorkflow from "./builtin"

import { loadBuiltinScripts } from "./builtin.macro" with { type: "macro" }
import { loadBuiltinScripts as loadBuiltinScriptsDev } from "./builtin.macro"
import { parseMeta } from "./meta"

export type Entry = {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  script: string
}

function safeLoadBuiltinScripts() {
  try {
    return loadBuiltinScripts()
  } catch (e) {
    if (e instanceof ReferenceError) return loadBuiltinScriptsDev()
    throw e
  }
}

const SCRIPTS = safeLoadBuiltinScripts()

const REGISTRY: Record<string, Entry> = Object.create(null)
for (const { file, script } of SCRIPTS) {
  const parsed = parseMeta(script)
  if (!parsed.ok) throw new Error(`built-in workflow ${file} failed to parse meta: ${parsed.error}`)
  const meta = parsed.meta
  REGISTRY[meta.name] = {
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse,
    phases: meta.phases,
    script,
  }
}

export function list(): Entry[] {
  return Object.values(REGISTRY).sort((a, b) => a.name.localeCompare(b.name))
}

export function get(name: string): Entry | undefined {
  return REGISTRY[name]
}
