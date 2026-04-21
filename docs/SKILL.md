---
name: playwright-test-diagnosis
description: Analyze playwright test results
---

## Goal

Turn `heal-traces.ndjson` into a concise root-cause report with statement-level evidence.

## Inputs To Locate

- `test-results/<test>/heal-data/heal-traces.ndjson`
- Related Playwright output (`stdout`, `stderr`, screenshots, stack trace)
- The test file mentioned in the trace (`statement.loc` and source text)

If multiple trace files exist, prioritize the latest failing attempt.

## Workflow

1. Find the `test-result` event and note final status, duration, stderr, and stdout.
2. Scan statement events in order and identify:
   - first failing statement (`status != ok`)
   - last successful statement before failure
   - slow statements (`durationMs` outliers)
3. Extract high-signal fields from failing/nearby statements:
   - `source`
   - `loc.line` and file context
   - captured variable values
   - serialized error payload
   - screenshot references (if present)
4. Build a timeline:
   - setup/context
   - trigger statement
   - error manifestation
   - propagation/teardown
5. Correlate with external signals:
   - network/API response mismatches
   - assertion target mismatch vs highlighted locator screenshot
   - helper-function internal state that does not surface in standard Playwright trace
6. Propose a minimal next action:
   - test fix
   - app fix
   - synchronization/waiting fix
   - selector/locator fix

## Heuristics

- Prefer the earliest causal mismatch, not the final thrown assertion.
- Treat statement-level values as source of truth when they contradict log text.
- Call out hidden helper failures explicitly (they are often invisible in action-level traces).
- For flaky behavior, compare passing and failing runs at the first diverging statement.
- Keep confidence explicit: `high`, `medium`, or `low`.

## Output Format

Use this structure:

```markdown
## Test Failure Analysis

- Test: <name>
- Status: <failed/passed>
- Confidence: <high|medium|low>

### What failed

- <1-2 bullets with exact failing statement and error>

### Root cause hypothesis

- <most likely cause tied to statement-level evidence>

### Evidence

- <statement source + line + key variable values>
- <timing or API correlation>
- <screenshot/locator evidence if available>

### Recommended fix

- <smallest practical change>

### Verification

- Re-run: <command>
- Expectation: <what should change in trace>
```

## Quick Commands

Use fast filters when needed:

- failing lines: `rg '"status":"(fail|error)"' test-results -g "*.ndjson"`
- slow statements: `rg '"durationMs":[1-9][0-9]{3,}' test-results -g "*.ndjson"`
- error payloads: `rg '"error"|\"stderr\"' test-results -g "*.ndjson"`
