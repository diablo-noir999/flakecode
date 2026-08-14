import type { Plugin } from "@opencode-ai/plugin"

const AI_SLOP_PATTERNS: Array<{ pattern: RegExp; replacement: string; name: string }> = [
  { pattern: /\u2014/g, replacement: " -- ", name: "em-dash" },
  { pattern: /\u2013/g, replacement: " - ", name: "en-dash" },
  { pattern: /\bsimply\b/gi, replacement: "", name: "simply" },
  { pattern: /\bobviously\b/gi, replacement: "", name: "obviously" },
  { pattern: /\bclearly\b/gi, replacement: "", name: "clearly" },
  { pattern: /\bmoreover\b/gi, replacement: "", name: "moreover" },
  { pattern: /\bfurthermore\b/gi, replacement: "", name: "furthermore" },
  { pattern: /\bin addition\b/gi, replacement: "", name: "in addition" },
  { pattern: /\bhowever\b/gi, replacement: "but", name: "however" },
  { pattern: /\butilize[sd]?\b/gi, replacement: "use", name: "utilize" },
  { pattern: /\bleverage[sd]?\b/gi, replacement: "use", name: "leverage" },
  { pattern: /\bfacilitate[sd]?\b/gi, replacement: "help", name: "facilitate" },
  { pattern: /\bvery important\b/gi, replacement: "important", name: "very important" },
  { pattern: /\bextremely\b/gi, replacement: "", name: "extremely" },
  { pattern: /\bessentially\b/gi, replacement: "", name: "essentially" },
  { pattern: /\bhere's the thing[:\s]/gi, replacement: "", name: "here's the thing" },
  { pattern: /\bthe uncomfortable truth is\b/gi, replacement: "", name: "the uncomfortable truth is" },
  { pattern: /\bit turns out\b/gi, replacement: "", name: "it turns out" },
  { pattern: /\bthe real [a-z]+ is\b/gi, replacement: "", name: "the real X is" },
  { pattern: /\blet me be clear\b/gi, replacement: "", name: "let me be clear" },
  { pattern: /\bthe truth is,?\b/gi, replacement: "", name: "the truth is" },
  { pattern: /\bmake no mistake\b/gi, replacement: "", name: "make no mistake" },
  { pattern: /\bfull stop\.?\b/gi, replacement: "", name: "full stop" },
  { pattern: /\blet that sink in\b/gi, replacement: "", name: "let that sink in" },
  { pattern: /\bat its core\b/gi, replacement: "", name: "at its core" },
  { pattern: /\bit's worth noting\b/gi, replacement: "", name: "it's worth noting" },
  { pattern: /\bat the end of the day\b/gi, replacement: "", name: "at the end of the day" },
  { pattern: /\bwhen it comes to\b/gi, replacement: "", name: "when it comes to" },
  { pattern: /\bthe reality is\b/gi, replacement: "", name: "the reality is" },
  { pattern: /\bin a world where\b/gi, replacement: "", name: "in a world where" },
  { pattern: /\bdeep dive\b/gi, replacement: "analysis", name: "deep dive" },
  { pattern: /\bgame[- ]changer\b/gi, replacement: "significant", name: "game-changer" },
  { pattern: /\bdouble down\b/gi, replacement: "commit", name: "double down" },
  { pattern: /\btake a step back\b/gi, replacement: "reconsider", name: "take a step back" },
  { pattern: /\bcircle back\b/gi, replacement: "revisit", name: "circle back" },
  { pattern: /\bon the same page\b/gi, replacement: "aligned", name: "on the same page" },
  { pattern: /\bbasically\b/gi, replacement: "", name: "basically" },
]

const COMBINED_SLOP_DETECT = new RegExp(
  AI_SLOP_PATTERNS.map(p => `(${p.pattern.source})`).join("|"),
  "gi"
)

export const CommentCheckerPlugin: Plugin = async () => {
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "edit") return
      const content = output.output
      if (typeof content !== "string" || !content) return

      COMBINED_SLOP_DETECT.lastIndex = 0
      if (!COMBINED_SLOP_DETECT.test(content)) return

      const issues: string[] = []
      for (const { pattern, name } of AI_SLOP_PATTERNS) {
        if (pattern.test(content)) {
          issues.push(name)
        }
        pattern.lastIndex = 0
      }

      if (issues.length > 0) {
        output.output = content + `\n\n[Comment Checker] Detected AI slop patterns: ${issues.join(", ")}. Consider removing these for cleaner comments.`
      }
    },
  }
}

export default CommentCheckerPlugin
