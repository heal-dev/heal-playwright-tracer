# Development

## How it works

```
  Build time (per worker)                        Runtime (per test)
  ───────────────────────                        ──────────────────

  test file                                      instrumented test
      │                                                 │
      ▼                                                 ▼
  ┌───────────────────┐                         ┌────────────────┐
  │  Babel plugin     │  ─── instrumented ───►  │  recorder      │
  │  code-hook-       │      (__enter /         │  enter/ok/     │
  │  injector         │       __ok / __throw)   │  throw stream  │
  └───────────────────┘                         └────────┬───────┘
                                                         │
                                                         ▼
                                                 ┌────────────────┐
                                                 │  statement     │
                                                 │  projector     │
                                                 └────────┬───────┘
                                                          │
                                                          ▼
   playwright.config.ts                           ┌──────────────────┐
   configureTracer({      ─── extends ──────────► │    composite     │
     exporters,                                   │     exporter     │
     lifecycles,                                  └───┬──────────┬───┘
   })                                                 │          │
                                                      ▼          ▼
                                                   NDJSON     custom
                                                    file     exporters
                                                           (HTTP, queue, …)
```

The Babel plugin wraps every leaf statement with a try/catch/finally
that calls three runtime hooks. The recorder pairs those calls into an
event stream, the projector folds them into `HealTraceRecord`s, and
a composite exporter fans them out to the default NDJSON file and
any exporters registered via `configureTracer`.

The plugin also rewrites `from '@playwright/test'` to
`from '@heal-dev/heal-playwright-tracer'` in every instrumented file,
so `test` and `expect` automatically resolve to the traced variants —
no manual import swap required.

## Why CommonJS?

The package ships as CommonJS (no `"type": "module"` in
`package.json`, `tsc` emits `module: commonjs`). This is deliberate:
Playwright's babel transform — the thing that actually loads
`code-hook-injector` — is itself a CJS module and consumes the plugin
via `require()`. Shipping ESM would force a dual build with no upside.

ESM consumers still work — use `createRequire` in
`playwright.config.ts` if you need to resolve the plugin path:

```ts
// playwright.config.ts  (package.json has "type": "module")
import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  // @ts-ignore
  '@playwright/test': {
    babelPlugins: [[require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector')]],
  },
});
```

> **The module format of `playwright.config.ts` must match the
> `"type"` field of its nearest `package.json`.** A mismatch causes
> Node to route the file through the wrong loader, typically surfacing
> as `ReferenceError: exports is not defined in ES module scope` —
> with a stack trace that blames this plugin even though it has never
> run. If that happens, fix the config format first.

### Extend: custom exporters and lifecycles

`configureTracer` registers extra exporters (fanned out alongside
the default NDJSON exporter) and per-test setup/teardown pairs —
useful for shipping traces to your own backend or installing
per-test globals:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { configureTracer } from '@heal-dev/heal-playwright-tracer';

configureTracer({
  exporters: [(ctx) => new MyHttpExporter(ctx.transport)],
  lifecycles: [
    () => ({
      setup: (ctx) => openTelemetrySession(ctx.testInfo),
      teardown: () => closeTelemetrySession(),
    }),
  ],
});

export default defineConfig({
  /* ... */
});
```

Full surface: [`src/application/heal-config/types.ts`](src/application/heal-config/types.ts).
Exporters implement [`HealTraceExporter`](src/domain/trace-event-recorder/port/heal-trace-exporter.ts)
(`write(record)` + `close()`).

## Print per-test artifact paths

Set `HEAL_PRINT_ARTIFACT_PATHS=1` to print the test's output
directory to stderr after each test. That directory contains every
artifact Playwright and this tracer produce for the test — the
nested `heal-data/` folder with the ndjson + highlight screenshots,
plus Playwright's own `trace.zip` and videos:

```sh
HEAL_PRINT_ARTIFACT_PATHS=1 npx playwright test
```

```
[heal-playwright-tracer] my test (passed)
  test artifacts dir: /path/to/test-results/foo
```

## CI

### Workflows

| Workflow                                | Trigger                               | Purpose                                                                                                                                      |
| --------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`              | push to `main`, PRs to `main`         | Typecheck, lint, unit tests + coverage, build, Codecov upload, Playwright integration matrix.                                                |
| `.github/workflows/bump-version.yml`    | `workflow_dispatch` (manual)          | Bumps `package.json` via `npm version`, opens a signed bump PR through the GitHub REST API.                                                  |
| `.github/workflows/private-release.yml` | `workflow_dispatch` only              | Publishes the package to GitHub Packages (`npm.pkg.github.com`). Requires a reviewer approval from the `release` environment before running. |
| `.github/workflows/scorecard.yml`       | push to `main`, weekly cron, dispatch | Runs OpenSSF Scorecard, uploads SARIF to Code Scanning, publishes to https://scorecard.dev.                                                  |

### Release flow

The package is published to two registries through **two different paths**:

- **Public npmjs.org** — released **manually** by a maintainer from their machine. Not in CI.
- **GitHub Packages (`npm.pkg.github.com`)** — released via the `Private Release` workflow.

Do **not** add `publishConfig` to `package.json`: it would force the manual npm publish to use GitHub Packages. The `private-release.yml` workflow pins the registry with `--registry=https://npm.pkg.github.com` on every `npm publish` instead.

To cut a private release:

1. **Dispatch `Bump Version`** (Actions → Bump Version → Run workflow, pick bump type). It opens a `chore: bump version to X` PR signed by `github-actions[bot]`.
2. **Merge the PR** — CI must be green; ruleset enforces 1 review, CODEOWNERS, status checks, thread resolution.
3. **Dispatch `Private Release`** and paste the exact new version (`X`) into the `confirm_version` input. The workflow aborts if the input doesn't match `package.json`.
4. **A different release-environment reviewer approves.** The publish step runs with `GITHUB_TOKEN` (`packages: write`, `id-token: write`) and `npm publish --provenance`. Slack notification fires on success/failure.

### Branch & tag protection

The `main` branch is protected by a repository ruleset (`Main (hardened)`):

- No force-push, no deletion, linear history required.
- PR required with 1 review, code-owner review, last-push approval, stale-review dismissal, thread resolution.
- Required status checks: `Lint / Unit coverage / Build`, `Integration (Playwright <version>)` for each matrix entry.
- No bypass actors — admins included.

Version tags matching `refs/tags/v*` are protected against deletion and force-push by a second ruleset.

> **When you change the CI matrix or rename a job**, update the required status checks on the `Main (hardened)` ruleset at https://github.com/heal-dev/heal-playwright-tracer/rules — the contexts are literal job-name matches, so a stale entry silently blocks every merge.

### Commit signing

The `main` branch has a `required_signatures` ruleset (currently in **evaluate mode** — reports pass/fail on PRs but does not block merges yet). Every human committer needs to configure signing once per machine; see [`signing.md`](./signing.md). Web-UI commits, Dependabot commits, and `github-actions[bot]` commits via the REST API are auto-signed and need no setup.

### Allowed actions

Repo-level Actions policy is `allowed_actions: "selected"` with `sha_pinning_required: true`. All `uses:` references **must be pinned to a full 40-character commit SHA** (tag refs are rejected at workflow parse time). Add a version tag as a trailing `# v4` comment so Dependabot can track and bump the pin.

Only these third-party actions are allowed (in addition to any GitHub-owned or verified-creator action):

- `davelosert/vitest-coverage-report-action@*`
- `codecov/codecov-action@*`
- `slackapi/slack-github-action@*`
- `peter-evans/create-pull-request@*`
- `ossf/scorecard-action@*`

Using a new third-party action requires updating this allowlist on GitHub (`/settings/actions` → Allow selected actions).

### Secrets

Repo secrets currently used by workflows:

- `CODECOV_TOKEN` — `ci.yml` Codecov upload.
- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` — `private-release.yml` notifications.

`private-release.yml` publishes with `secrets.GITHUB_TOKEN`, not a PAT. If a step ever needs more than the default read-only `GITHUB_TOKEN`, elevate explicitly in that job's `permissions:` block.
