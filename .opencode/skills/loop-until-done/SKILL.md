---
name: loop-until-done
description: Autonomous loop that repeats a task until completion. Use when you need to iteratively work on something until it's fully done.
---

# Loop Until Done

Repeat a task autonomously until a completion signal is met. Use this when you need to iteratively work on something — fixing tests, building incrementally, or retrying until success.

## When to Use

- Getting tests to pass through iteration
- Building a feature incrementally
- Fixing issues that require multiple attempts
- Any task where "keep trying until it works" is appropriate

## How It Works

1. Define the task and completion criteria clearly
2. Execute the task
3. Check output for the completion signal
4. If not met, update context with what changed and retry
5. Continue until completion or max iterations reached

## Process

```
1. Define task:
   - What to do
   - What "done" looks like (completion signal)
   - Maximum iterations (safety limit)

2. Execute:
   - Run the task
   - Capture output and side effects

3. Evaluate:
   - Did the completion signal appear?
   - If yes → stop, report success
   - If no → update context, retry

4. Safety:
   - Always set a max iterations limit
   - Track what changed between iterations
   - Report progress each iteration
```

## Example

```
Task: "Fix failing tests in auth.test.ts"
Completion signal: "All 12 tests pass"
Max iterations: 20

Iteration 1: Run tests → 8 pass, 4 fail → fix one test
Iteration 2: Run tests → 9 pass, 3 fail → fix another
...
Iteration 6: Run tests → 12 pass → DONE
```

## Tips

- Always set a max iterations limit for safety
- Include clear success criteria in your prompt
- The completion signal must appear exactly as specified
- Use context parameter for hints if the agent gets stuck
- Report what changed each iteration for transparency
- If stuck after 3 iterations on the same issue, reconsider the approach
