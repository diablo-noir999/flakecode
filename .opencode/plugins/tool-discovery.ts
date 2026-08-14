/**
 * Tool Discovery Plugin
 *
 * Provides context about available tools and their usage patterns.
 * Delivers tool discovery instructions via system prompt injection.
 *
 * Adapted from MiMo-Code Powerpack tool-discovery hook.
 * Uses system.transform hook instead of message injection for OpenCode compatibility.
 */

import { Effect } from "effect"

// === Tool Discovery Config ===

export interface ToolDiscoveryConfig {
  /** Enable tool discovery injection */
  enabled: boolean
  /** Maximum tools to list in context */
  maxTools?: number
  /** Categories to include */
  categories?: string[]
}

export const DEFAULT_TOOL_DISCOVERY_CONFIG: ToolDiscoveryConfig = {
  enabled: true,
  maxTools: 50,
  categories: ["file", "search", "shell", "knowledge", "orchestration"],
}

// === Tool Registry ===

interface ToolInfo {
  name: string
  category: string
  description: string
  whenToUse: string
}

const KNOWN_TOOLS: ToolInfo[] = [
  // File tools
  { name: "read", category: "file", description: "Read file contents", whenToUse: "Reading source files, configs, docs" },
  { name: "write", category: "file", description: "Write file contents", whenToUse: "Creating new files" },
  { name: "edit", category: "file", description: "Edit existing files", whenToUse: "Modifying existing code" },
  { name: "multiedit", category: "file", description: "Edit multiple files", whenToUse: "Multiple file changes" },

  // Search tools
  { name: "glob", category: "search", description: "Find files by pattern", whenToUse: "Locating files" },
  { name: "grep", category: "search", description: "Search file contents", whenToUse: "Finding code patterns" },
  { name: "codesearch", category: "search", description: "Semantic code search", whenToUse: "Finding related code" },

  // Shell tools
  { name: "bash", category: "shell", description: "Execute shell commands", whenToUse: "Running commands, scripts" },

  // Knowledge tools
  { name: "webfetch", category: "knowledge", description: "Fetch web content", whenToUse: "Reading documentation" },
  { name: "websearch", category: "knowledge", description: "Search the web", whenToUse: "Researching topics" },
  { name: "memory", category: "knowledge", description: "Search project memory", whenToUse: "Recalling past decisions" },

  // Orchestration tools
  { name: "task", category: "orchestration", description: "Track work items", whenToUse: "Multi-step tasks" },
  { name: "actor", category: "orchestration", description: "Spawn subagents", whenToUse: "Parallel work" },
  { name: "skill", category: "orchestration", description: "Load specialized skills", whenToUse: "Domain-specific tasks" },
]

// === Tool Discovery Logic ===

/**
 * Generate tool discovery context for the system prompt.
 */
export function generateToolDiscoveryContext(
  config: ToolDiscoveryConfig = DEFAULT_TOOL_DISCOVERY_CONFIG
): string {
  const tools = config.categories
    ? KNOWN_TOOLS.filter((t) => config.categories!.includes(t.category))
    : KNOWN_TOOLS

  const limited = config.maxTools ? tools.slice(0, config.maxTools) : tools

  const lines = ["## Available Tools", ""]

  for (const category of new Set(limited.map((t) => t.category))) {
    const catTools = limited.filter((t) => t.category === category)
    lines.push(`### ${category}`)
    for (const tool of catTools) {
      lines.push(`- **${tool.name}**: ${tool.description} — ${tool.whenToUse}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * Create a tool discovery hook for OpenCode's plugin system.
 * Returns an async function matching the system transform signature.
 */
export function createToolDiscoveryHook(
  config: ToolDiscoveryConfig = DEFAULT_TOOL_DISCOVERY_CONFIG
) {
  return async (input: any, output: any): Promise<void> => {
    if (!config.enabled) return

    // Inject tool discovery context into system prompt
    const toolContext = generateToolDiscoveryContext(config)

    if (output?.systemPrompt) {
      output.systemPrompt += "\n\n" + toolContext
    }
  }
}

// === Exports ===

export { type ToolInfo, KNOWN_TOOLS }
