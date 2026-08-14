export * as ConfigHistory from "./history"

import { Schema } from "effect"

export const Kind = Schema.Literals([
  "user_text",
  "assistant_text",
  "tool_input",
  "tool_error",
  "reasoning",
  "tool_output",
])

export const Info = Schema.Struct({
  kinds: Schema.optional(Schema.Array(Kind)).annotate({
    description:
      "Which part kinds the history FTS index should cover. Defaults to text (user/assistant) + tool input + tool errors.",
  }),
})

export type Info = Schema.Schema.Type<typeof Info>
