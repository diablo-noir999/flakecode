import type { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import type { Interface as InboxInterface } from "./inbox"

export interface SessionPromptLoopRef {
  loop: (input: {
    sessionID: SessionID
    agentID: string
    notifyParentOnComplete?: boolean
  }) => Effect.Effect<MessageV2.WithParts>
}

export const sessionPromptRef: { current: SessionPromptLoopRef | undefined } = {
  current: undefined,
}

export interface DefaultModelRef {
  defaultModel: () => Effect.Effect<{ providerID: string; modelID: string }>
}

export const defaultModelRef: { current: DefaultModelRef | undefined } = {
  current: undefined,
}

export const inboxServiceRef: { current: InboxInterface | undefined } = {
  current: undefined,
}
