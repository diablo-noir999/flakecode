import { Effect, Layer, Schema } from "effect"
import { Memory } from "../memory"
import { Tool } from "./tool"

const input = Schema.Struct({
  operation: Schema.optional(Schema.Literal("search")),
  query: Schema.String,
  scope: Schema.optional(Schema.Literals(["global", "projects", "sessions"])),
  scope_id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

const output = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      snippet: Schema.String,
      score: Schema.Number,
      scope: Schema.String,
      scope_id: Schema.String,
      type: Schema.String,
    }),
  ),
})

export function make(memory: Memory.Interface) {
  return Tool.make({
    description: "Search the memory store using BM25 full-text search over indexed markdown bodies.",
    input,
    output,
    execute: (args) =>
      Effect.gen(function* () {
        const results = yield* memory.search({
          query: args.query,
          scope: args.scope,
          scope_id: args.scope_id,
          type: args.type,
          limit: args.limit,
        })
        return { results }
      }),
    toModelOutput: ({ input: inp, output: out }) => [
      {
        type: "text" as const,
        text: out.results.length === 0
          ? `No matches for "${inp.query}".`
          : `Found ${out.results.length} match${out.results.length === 1 ? "" : "es"} (BM25-ranked, best first).\n${out.results.map((r) => `### ${r.path}\nScope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}\n${r.snippet}`).join("\n\n")}`,
      },
    ],
  })
}
