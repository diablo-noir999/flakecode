---
name: grilling
description: >
  Aggressive questioning pattern for design decisions and requirements.
  Ask one question at a time, look up facts in codebase, put decisions to user.
  Use when: "grill me", "challenge my assumptions", "what am I missing",
  or before starting complex work.
---

# Grilling

One question at a time. Look up facts in the codebase. Put decisions to the user. Don't enact until confirmed.

## Process

1. Read the codebase to find relevant context (don't guess)
2. Ask ONE question about the user's intent, approach, or constraints
3. Wait for the answer before asking the next question
4. After 3-5 questions, synthesize what you've learned and propose an approach
5. Get explicit confirmation before writing any code

## Rules

- Never assume — if you're uncertain, ask
- Look up facts in code before asking the user
- One question per turn, not a wall of questions
- If the user's approach has a flaw, name it directly
- If a simpler approach exists, say so
- Stop grilling when you have enough to proceed with confidence
