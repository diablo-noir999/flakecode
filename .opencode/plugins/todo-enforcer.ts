import type { Plugin } from "@opencode-ai/plugin"

interface SessionState {
  failureCount: number
  lastInjection: number
  cooldownUntil: number
}

const sessionStates = new Map<string, SessionState>()

const MAX_CONSECUTIVE_FAILURES = 5
const COOLDOWN_MS = 30000
const EXPONENTIAL_BACKOFF_BASE = 2
const SESSION_EVICT_AGE_MS = 3600_000

function evictStaleSessions(): void {
  const now = Date.now()
  for (const [id, s] of sessionStates) {
    if (s.lastInjection > 0 && now - s.lastInjection > SESSION_EVICT_AGE_MS) {
      sessionStates.delete(id)
    }
  }
}

export const TodoEnforcerPlugin: Plugin = async (_ctx, options) => {
  const enabled = (options?.enabled as boolean) ?? true
  const maxFailures = (options?.maxFailures as number) ?? MAX_CONSECUTIVE_FAILURES
  const cooldownMs = (options?.cooldownMs as number) ?? COOLDOWN_MS

  return {
    event: async ({ event }) => {
      if (!enabled) return
      if (event.type !== "session.idle") return

      evictStaleSessions()

      const sessionID = event.properties?.sessionID ?? ""
      if (!sessionID) return

      let state = sessionStates.get(sessionID)
      if (!state) {
        state = { failureCount: 0, lastInjection: 0, cooldownUntil: 0 }
        sessionStates.set(sessionID, state)
      }

      const now = Date.now()
      if (now < state.cooldownUntil) return

      // Check if there are recent messages suggesting ongoing work.
      // Without direct access to session messages via event, we track based on
      // consecutive idle events. If the session keeps going idle, it likely has
      // incomplete work that needs continuation.
      const hasRecentActivity = state.failureCount > 0 || (state.lastInjection > 0 && now - state.lastInjection < 300_000)

      if (!hasRecentActivity) {
        state.failureCount = 0
        return
      }

      if (state.failureCount >= maxFailures) {
        const backoffMs = COOLDOWN_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, state.failureCount - maxFailures)
        state.cooldownUntil = now + Math.min(backoffMs, 300000)
        return
      }

      state.failureCount++
      state.lastInjection = now
      state.cooldownUntil = now + cooldownMs

      // TODO: Deliver CONTINUATION_PROMPT via the session API when supported
    },
  }
}

export default TodoEnforcerPlugin
