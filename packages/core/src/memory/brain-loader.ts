/**
 * Brain Context Loader
 *
 * Reads the Obsidian-style wiki vault at .mimocode/context/wiki/ and
 * injects a concise project brain context into the session's first message.
 * Enables instant session resumption from pre-digested knowledge.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

// === Types ===

export interface BrainContextResult {
  injected: boolean
  source: string | null
  tokenEstimate: number
}

// === Constants ===

const CONTEXT_DIR = ".mimocode/context"
const WIKI_DIR = "wiki"
const INDEX_FILE = "index.md"
const MAX_CHARS_PER_TOKEN = 4

// === Core ===

/**
 * Read brain context from the wiki vault.
 * Returns the content to inject plus metadata, or null if no vault exists.
 */
export function readBrainContext(
  projectPath: string,
  maxTokens = 8000,
): BrainContextResult {
  const contextDir = join(projectPath, CONTEXT_DIR)
  const wikiDir = join(contextDir, WIKI_DIR)
  const indexFile = join(wikiDir, INDEX_FILE)

  if (!existsSync(indexFile)) {
    return { injected: false, source: null, tokenEstimate: 0 }
  }

  const maxChars = maxTokens * MAX_CHARS_PER_TOKEN
  const parts: string[] = []

  // Read index
  try {
    const indexContent = readFileSync(indexFile, "utf-8")
    parts.push(indexContent)
  } catch {
    return { injected: false, source: null, tokenEstimate: 0 }
  }

  // Read top linked notes (follow [[wiki/note-name]] links)
  const linkedNotes = extractWikilinks(parts[0])
  let charCount = parts[0].length

  for (const noteName of linkedNotes) {
    if (charCount >= maxChars) break
    const notePath = join(wikiDir, `${noteName}.md`)
    if (!existsSync(notePath)) continue
    try {
      const content = readFileSync(notePath, "utf-8")
      parts.push(`\n---\n## ${noteName}\n${content}`)
      charCount += content.length
    } catch {
      // Skip unreadable notes
    }
  }

  // Also check topics/ subdirectory
  const topicsDir = join(wikiDir, "topics")
  if (existsSync(topicsDir) && charCount < maxChars) {
    try {
      const topicFiles = readdirSync(topicsDir).filter(f => f.endsWith(".md"))
      for (const tf of topicFiles) {
        if (charCount >= maxChars) break
        const topicPath = join(topicsDir, tf)
        try {
          const content = readFileSync(topicPath, "utf-8")
          parts.push(`\n---\n## topics/${tf.replace(".md", "")}\n${content}`)
          charCount += content.length
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }
  }

  // Also read output/status.md if present
  const statusFile = join(contextDir, "output", "status.md")
  if (existsSync(statusFile) && charCount < maxChars) {
    try {
      const content = readFileSync(statusFile, "utf-8")
      parts.push(`\n---\n## Project Status\n${content}`)
      charCount += content.length
    } catch {
      // Skip
    }
  }

  const combined = parts.join("\n")
  const tokenEstimate = Math.ceil(combined.length / MAX_CHARS_PER_TOKEN)

  return {
    injected: true,
    source: indexFile,
    tokenEstimate,
    _content: combined,
  } as BrainContextResult & { _content: string }
}

/**
 * Extract [[wikilinks]] from markdown content.
 * Returns note names (without [[ ]] and without paths).
 */
function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]]+)\]\]/g
  let match
  while ((match = regex.exec(content)) !== null) {
    const ref = match[1]
    // Take the last segment if it's a path like wiki/topics/foo
    const name = ref.includes("/") ? ref.split("/").pop()! : ref
    if (!links.includes(name)) links.push(name)
  }
  return links
}

/**
 * Build the injection message for the transform pipeline.
 */
export function buildBrainInjectionMessage(
  projectPath: string,
  maxTokens = 8000,
): { role: string; content: string } | null {
  const result = readBrainContext(projectPath, maxTokens)
  if (!result.injected || !result.source) return null

  const ctx = result as BrainContextResult & { _content: string }
  return {
    role: "system",
    content: `## Project Brain Context\nSource: .mimocode/context/\nTokens: ~${ctx.tokenEstimate}\n\n${ctx._content}`,
  }
}
