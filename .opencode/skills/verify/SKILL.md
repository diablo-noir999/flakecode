---
name: verify
description: Check anything works correctly and securely — code review, security audit, test generation, invariant checking, architecture validation. Routes to code review, security analysis, test writing, or threat modeling. Use after build or before shipping.
license: CC-BY-4.0
---

# Verify

Nothing ships without verification. Verification is not optional polish — it's the proof that build did what plan intended.

## Routing

| What the user needs | Mode |
|---|---|
| Review code quality and correctness | → **Review** |
| Find security vulnerabilities | → **Security** |
| Generate or improve tests | → **Test** |
| Check architecture validity | → **Architecture** |
| Stress-test a decision or idea | → **Challenge** (routes to `plan` Challenge mode) |

---

## Mode: Review

Code review with surgical precision. Every finding: location, problem, fix.

### Format
```
<file>:L<line>: <severity>: <problem>. <fix>.
```

**Severity prefixes:**
- `bug:` — broken behavior, will cause incorrect output or crash
- `risk:` — works now but fragile (race condition, missing null check, swallowed error)
- `nit:` — style, naming, minor cleanup
- `q:` — genuine question, not a suggestion

### Rules
1. Findings only — no praise, no hedging, no "I noticed that..."
2. Exact line numbers and symbol names in backticks
3. Include the *why* if the fix isn't self-evident
4. Don't review what wasn't changed — scope to the diff

### What to always check
- [ ] Error cases handled explicitly (not silently ignored)
- [ ] No magic numbers or hardcoded values that should be config
- [ ] No dead code or commented-out code
- [ ] Functions doing one thing (>30 lines is a smell, >50 is a problem)
- [ ] Return types and error types explicit in public API
- [ ] No `unwrap()` in Rust unless provably safe (comment why)
- [ ] No `any` in TypeScript public API
- [ ] No `console.log` left in production code
- [ ] Imports only what's used

### Language-specific checks

**Rust**
- `unwrap()`/`expect()` outside tests → must have comment explaining why it's safe
- `clone()` in hot paths → flag for review
- `pub` fields on structs that should be encapsulated
- Missing `#[derive(Debug)]` on public types

**TypeScript**
- `as any` casts without comment
- Unhandled promise rejections (floating promises)
- Missing error handling in async functions
- Type assertions (`!`) without safety check

**Solidity**
- External calls before state updates (reentrancy)
- `tx.origin` for auth (use `msg.sender`)
- Missing access control on state-changing functions
- Integer operations without overflow check (pre-0.8.0)
- Unchecked return values from external calls

---

## Mode: Security

Security analysis of code, systems, or architectures.

### Two sub-modes

**Passive (default):** Run while implementing. Flag issues inline. Don't slow down the build.

**Full report:** When asked explicitly. Produces `security_report.md`.

### Threat modeling process (for architectures)
1. **Identify assets** — what has value and must be protected
2. **Identify entry points** — where input enters the system
3. **Identify trust boundaries** — where trust level changes
4. **Enumerate threats** — for each boundary/entry: what can an attacker do?
5. **Prioritize** — likelihood × impact
6. **Mitigate** — concrete code changes, not generic advice

### Threat classification
| Level | Examples |
|---|---|
| Critical | Pre-auth code execution, auth bypass, key theft |
| High | Privilege escalation, data exfiltration, fund drain |
| Medium | DoS, partial data exposure, rate limit bypass |
| Low | Info leaks, noisy DoS, minor misconfigurations |

### Common vulnerability patterns by domain

**Smart contracts**
- Reentrancy: external call before state update
- Access control: missing `onlyOwner` or role checks
- Oracle manipulation: price from manipulable AMM spot price
- Integer overflow: arithmetic without SafeMath (pre-0.8.0)
- Storage collision: proxy upgrade storage layout mismatch
- Initialization: uninitialized proxy implementation

**Node.js / TypeScript APIs**
- Injection: unsanitized input in shell commands (`child_process`)
- Path traversal: user-controlled file paths
- Prototype pollution: unsafe object merging
- Hardcoded secrets in source

**Rust systems**
- Unsafe blocks without safety invariant comments
- Integer overflow in release mode (no panic in release)
- Improper deserialization of untrusted input

**Cryptographic systems**
- Nonce reuse in symmetric encryption
- Timing side channels in comparison functions
- Weak RNG for key generation
- Missing signature verification before state update

### Report format
```markdown
# Security Report — [component/date]

## Executive Summary
[2-3 sentences: overall posture, highest severity finding]

## Findings

### [CRITICAL-001] [Title]
**Location:** file:line
**Impact:** What an attacker can do
**Likelihood:** High/Medium/Low
**Root cause:** Why the vulnerability exists
**Fix:** Specific code change
**References:** CWE/SWC ID if applicable

[repeat for each finding]

## What Was Not Checked
[explicit scope limitations]
```

---

## Mode: Test

Generate or improve tests for existing code.

### Test hierarchy — always prefer higher levels

```
Unit → Integration → End-to-end
Fast   Medium        Slow
Many   Some          Few
```

### Rules
1. Write characterization tests for untested code BEFORE refactoring
2. Tests should be: Arrange → Act → Assert. No logic in tests.
3. Test behavior, not implementation. Tests shouldn't break on refactors.
4. One assertion per test (or one logical group of assertions)
5. Test names describe the scenario: `test_withdraw_fails_when_balance_insufficient`

### Coverage analysis
```bash
# Rust
cargo tarpaulin --out Html

# TypeScript
npx jest --coverage

# Foundry
forge coverage --report lcov
genhtml lcov.info -o coverage-report
```

Read coverage output: find uncovered branches (not just lines). Each uncovered branch is a potential bug.

### Invariant testing (for stateful systems)
Write properties that must ALWAYS hold:
```
"totalSupply always equals sum of all balances"
"nonce always increments monotonically per account"
"balance never goes below zero"
"owner is never address(0) after initialization"
```

**Foundry invariant test:**
```solidity
function invariant_totalSupplyMatchesBalances() public {
    uint sum = 0;
    for (uint i = 0; i < users.length; i++) {
        sum += token.balanceOf(users[i]);
    }
    assertEq(token.totalSupply(), sum);
}
```

**Rust property test (proptest):**
```rust
proptest! {
    #[test]
    fn encode_decode_roundtrip(diff in arbitrary_state_diff()) {
        let encoded = encode(&diff);
        let decoded = decode(&encoded).unwrap();
        prop_assert_eq!(diff, decoded);
    }
}
```

---

## Mode: Architecture

Verify an architecture against its requirements.

### Checklist
- [ ] Every requirement maps to a component
- [ ] No component without a stated responsibility
- [ ] Data flow is traceable end-to-end
- [ ] Failure modes are documented (what happens when each component fails)
- [ ] Security boundaries are explicit
- [ ] No single points of failure (or they are documented and accepted)
- [ ] Dependencies are unidirectional (no cycles)
- [ ] The simplest solution that meets requirements (YAGNI check)

### YAGNI check
For each component/abstraction: "What requirement does this exist to satisfy?" If no clear answer: flag for removal.

---

## Connector Workflows

- Security findings that require architectural changes → go back to `plan` (Architecture mode)
- Test gaps that require new features → go back to `plan` (Feature mode)
- Code review findings → go back to `build` (Fix mode)
- After verify passes → the task is done, update STATE.md