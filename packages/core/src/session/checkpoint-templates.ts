export const CHECKPOINT_TEMPLATE = `# Session checkpoint

## Active intent
_User's most recent explicit request, verbatim block-quoted from the conversation._

(none yet)

## Next concrete action
_The single next concrete step, derived from intent and current state._

(none yet)

## Current work
_Description of what was being done immediately before this checkpoint. Mention specific file paths and code locations._

(none yet)

## Files and code sections
_Files actively being read or modified. List with one-line purpose._

(none yet)

## Errors and fixes
_Errors encountered this session and how they were resolved. Newest first._

(none)

## Design decisions
_Decisions reached through discussion. Captures user intent or trade-off rationale._

(none yet)

## Open notes
_Catch-all for items that don't fit above. Quotes, unresolved questions, observations._

(none yet)
`

/**
 * Section budgets for checkpoint.md (token estimates per section).
 */
export const CHECKPOINT_SECTION_BUDGETS: Record<string, number> = {
  "Active intent": 500,
  "Next concrete action": 1000,
  "Current work": 2000,
  "Files and code sections": 1500,
  "Errors and fixes": 1500,
  "Design decisions": 2000,
  "Open notes": 800,
}
