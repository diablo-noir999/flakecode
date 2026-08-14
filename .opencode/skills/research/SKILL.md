---
name: research
description: "Research any topic across multiple sources (Reddit, X, YouTube, HN, Polymarket, GitHub, web). Synthesizes engagement-weighted findings into one brief. Use when you need to understand what people actually say about a topic."
---

# Research

Multi-source, engagement-weighted research synthesis.

## Sources (parallel search)

| Source | Signal |
|--------|--------|
| Reddit | Upvotes, top comments, unfiltered opinions |
| X / Twitter | Hot takes, expert threads, breaking reactions |
| YouTube | Transcripts, deep dives, quotable insights |
| Hacker News | Developer consensus, technical arguments |
| Polymarket | Odds backed by real money, not pundit guesses |
| GitHub | PR velocity, stars, release notes, issues |
| Web | Editorial coverage, blog comparisons |

## Process

1. **Search all sources in parallel** — don't wait for one to finish before starting another
2. **Score by engagement** — upvotes, likes, views, odds, star counts
3. **Synthesize** — AI agent judges what actually matters, not what's newest
4. **Output one brief** — no section headers, no Sources block, just findings

## Output Format

```
🌐 research · {date}

What I learned:

**{Key finding 1}** — {evidence with engagement metrics}
**{Key finding 2}** — {evidence with engagement metrics}
**{Key finding 3}** — {evidence with engagement metrics}

KEY PATTERNS from the research:
1. {pattern with evidence}
2. {pattern with evidence}
3. {pattern with evidence}
```

## Rules (non-negotiable)

1. **No Sources block** at the end — the evidence is inline
2. **No invented titles** — "What I learned:" is the only header
3. **No em-dashes** — use ` - ` (hyphen with spaces)
4. **No section headers** — bold-lead-in paragraphs only
5. **No improvisation** — follow this contract top to bottom

## When to Use

- Before a meeting (understand the person/company)
- When something drops (get the real reaction)
- To compare tools (community consensus, not marketing)
- To understand the world (engagement-weighted news)

## Chains to
`plan` if research reveals implementation tasks
`build` if research answers a coding question