# Streaming output and the local heal-agent

The tracer writes every test's output as a stream of NDJSON records
instead of a single JSON file. Each record is one line. The stream
can be written to disk (crash-safe record of truth) and/or pushed
live to a long-lived local `heal-agent` sidecar (best-effort, for
real-time observability). Both paths are independent and can be
enabled separately.

## Wire format

Per test, `heal-data/heal-traces.ndjson` contains:

```
{"kind":"test-header","schemaVersion":1,"test":{...}}
{"kind":"statement","statement":{...children:[...]...}}
{"kind":"statement","statement":{...}}
...
{"kind":"test-result","status":"passed","duration":1234,...}
```

- Exactly one `test-header` as the first line.
- Zero or more `statement` records, each a **root** statement (directly
  inside the test body). Nested calls live inline in
  `statement.children` and never appear as standalone records.
- Exactly one `test-result` as the last line. If missing, the test
  crashed mid-run; treat the trace as partial.

Full schema: `src/features/trace-output/statement-trace-schema.ts`
(exported via `heal-playwright-tracer/statement-trace-schema`).

## Two delivery legs

| Leg             | Transport               | Durability         | Latency        | Default |
| --------------- | ----------------------- | ------------------ | -------------- | ------- |
| **NDJSON file** | `fs.writeSync` per line | crash-safe on disk | immediate      | on      |
| **Local agent** | HTTP to `127.0.0.1`     | best-effort (RAM)  | ~200ms batches | off     |

The NDJSON file is the record of truth. The agent leg is for live
observability (watching traces as tests run); losing its tail on
crash is acceptable because the file still has everything.

## Env vars — fixture side

| Variable                | Default                   | Effect                                                                                                                                      |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAL_TRACE_NDJSON`     | `on`                      | Write `heal-data/heal-traces.ndjson`. Disable with `0`/`false`/`off`.                                                                       |
| `HEAL_TRACE_AGENT`      | `off`                     | Push records to the local agent over HTTP. Enable with `1`/`true`/`on`.                                                                     |
| `HEAL_TRACE_AGENT_PORT` | —                         | Port where the agent is listening. Set by `global-setup.ts`; consumers don't need to touch it.                                              |
| `HEAL_AGENT_PORT_FILE`  | `.heal-agent-port` in cwd | Path to the port-handshake file written by the agent and read by the fixture.                                                               |
| `HEAL_EXECUTION_ID`     | —                         | Optional external identifier surfaced as `test.context.executionId`. Useful for CI pipelines to correlate a heal run with their own job id. |

Flag parsing: empty/unset = default; anything not in
`{0, false, off, no}` counts as "on."

## Per-test correlation (`test.context`)

Every `test-header` record carries a `context` block used to
correlate tests across the tracer and external systems:

| Field         | Scope                      | Source                                                                                                                                                                        |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`       | one per **test**           | Auto-generated UUIDv4 keyed by `testInfo.testId`. Shared across every attempt (first run + retries) of one test. Two different tests always get different runIds.             |
| `attempt`     | one per **attempt**        | 1-indexed: `testInfo.retry + 1`. First run is `1`, first retry is `2`, etc.                                                                                                   |
| `executionId` | one per **Playwright run** | Verbatim value of `HEAL_EXECUTION_ID` if set; omitted otherwise. Inherited by every worker spawned by `npx playwright test`, so every test in the run carries the same value. |

## Env vars — agent side

These are read by the `heal-agent` process itself.

| Variable                  | Default                   | Effect                                                                                                                      |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `HEAL_AGENT_HOST`         | `127.0.0.1`               | Bind host.                                                                                                                  |
| `HEAL_AGENT_PORT`         | `0`                       | Bind port (0 = OS-assigned).                                                                                                |
| `HEAL_AGENT_PORT_FILE`    | `.heal-agent-port` in cwd | Where the agent writes its bound port for the fixture to discover.                                                          |
| `HEAL_AGENT_DESTINATIONS` | `console`                 | Comma-separated destinations. Today only `console` exists; new destinations plug into `src/agent/destinations/registry.ts`. |

## Modes

### 1. NDJSON only (default)

Nothing to configure. The fixture writes
`testInfo.outputDir/heal-data/heal-traces.ndjson` per test.

### 2. NDJSON + live agent

1. Wire the global hooks in `playwright.config.ts`:

   ```ts
   export default defineConfig({
     globalSetup: require.resolve('heal-playwright-tracer/global-setup'),
     globalTeardown: require.resolve('heal-playwright-tracer/global-teardown'),
     // ...
   });
   ```

2. Set the env flag before running Playwright:

   ```bash
   HEAL_TRACE_AGENT=1 npx playwright test
   ```

The global-setup spawns `node dist/agent/index.js`, waits for its
`GET /healthz` probe, and publishes the port to workers via
`HEAL_TRACE_AGENT_PORT`. Each test fixture then constructs an
`AgentHttpSink` pointing at that port alongside the NDJSON sink.
Global-teardown `POST /v1/shutdown` drains and stops the agent.

### 3. Agent only (no NDJSON)

Rare but supported — useful if disk writes are undesirable:

```bash
HEAL_TRACE_NDJSON=0 HEAL_TRACE_AGENT=1 npx playwright test
```

### 4. Neither

```bash
HEAL_TRACE_NDJSON=0 npx playwright test
```

The projector still runs but writes to a no-op sink. Tests work;
nothing is persisted.

## What the agent does today

`heal-agent` is a scaffold. It:

- Runs as a long-lived sidecar bound to `127.0.0.1`.
- Accepts `POST /v1/events` with `{events: HealTraceRecord[]}`.
- Fans the batch out to every enabled `Destination`.
- Responds to `GET /healthz` for the fixture's startup probe.
- Drains and exits on `POST /v1/shutdown`, `SIGTERM`, `SIGINT`, or
  when its parent process disappears (orphan protection).

The only destination shipped is `console`, which logs each record
to stdout with a `[heal-agent]` prefix. It exists to prove the
end-to-end pipe; real destinations (HTTP shipper, message queue,
database) slot into `src/agent/destinations/` behind the same
`Destination` interface and are selected via
`HEAL_AGENT_DESTINATIONS`.

## Crash behavior

| What dies               | What's preserved                                                              |
| ----------------------- | ----------------------------------------------------------------------------- |
| Test process `SIGKILL`  | NDJSON file is intact up to the last `writeSync`. Live leg loses its tail.    |
| Agent crashes mid-run   | NDJSON untouched. Tests keep running; agent-http writes silently drop.        |
| Upstream dest. down     | Destination receives the errors; agent logs and keeps serving the next batch. |
| Playwright force-killed | `globalTeardown` may not run; agent self-terminates on parent-pid loss.       |
