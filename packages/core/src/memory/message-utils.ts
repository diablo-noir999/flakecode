/**
 * Shared message utilities for memory module.
 *
 * Helper functions used by both session-facts and smart-drops
 * for extracting tool information from message objects.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getToolName(message: any): string | null {
  if (typeof message.name === "string") return message.name;
  if (typeof message.tool === "string") return message.tool;
  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (isRecord(part)) {
        if (typeof part.tool === "string") return part.tool;
        if (typeof part.toolName === "string") return part.toolName;
        if (typeof part.name === "string") return part.name;
      }
    }
  }
  return null;
}

export function getToolInput(message: any): Record<string, unknown> | null {
  if (isRecord(message.arguments)) return message.arguments;
  if (isRecord(message.input)) return message.input;
  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (isRecord(part)) {
        if (isRecord(part.state) && isRecord(part.state.input)) return part.state.input;
        if (isRecord(part.args)) return part.args;
        if (isRecord(part.input)) return part.input;
      }
    }
  }
  return null;
}
