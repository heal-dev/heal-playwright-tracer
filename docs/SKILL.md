---
name: playwright-test-diagnosis
description: Analyze playwright test results
---

## Goal

Turn `heal-traces.ndjson` into a concise root-cause report with statement-level evidence.

## Inputs To Locate

- `heal-traces/<executionId>/<playwrightTestId>/<attempt>/heal-traces.ndjson`
- Sibling artefacts in the same `<attempt>/` dir: `trace.zip`,
  `screenshots/stmt-*.png`, `videos/<file>.webm` (when present)
- `heal-traces/executions.ndjson` — append-only run index; the latest
  line is the most recent run
- `heal-traces/<executionId>/execution.json` — per-run manifest
  (totals, git, duration, per-test summaries)
- The test file mentioned in the trace (`statement.loc` and source text)

If multiple trace files exist, prioritize the latest failing attempt.
`<executionId>` is an auto-generated uuidv4 per run; pick the newest
entry in `executions.ndjson` to find the most recent execution dir.

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

- failing lines: `rg '"status":"(fail|error)"' heal-traces -g "*.ndjson"`
- slow statements: `rg '"durationMs":[1-9][0-9]{3,}' heal-traces -g "*.ndjson"`
- error payloads: `rg '"error"|\"stderr\"' heal-traces -g "*.ndjson"`
- latest run dir: `tail -n 1 heal-traces/executions.ndjson` → read `executionId`
