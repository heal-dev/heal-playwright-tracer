# Development

The package's docs are split by audience:

- [`architecture.md`](architecture.md) — runtime architecture
  (Babel plugin, recorder, projector, exporters) and the
  screenshot-capture pipeline (Chromium CDP path, Firefox/WebKit JS
  fallback, off-viewport handling, decoration timeouts). Read this
  first if you're contributing.
- [`configuration.md`](configuration.md) — end-user surface:
  `configureTracer`, custom exporters, lifecycles, the
  `screenshotMs` / `lifecycleMs` knobs, ESM consumer guidance, the
  `HEAL_PRINT_ARTIFACT_PATHS` debug env var.
- [`ci.md`](ci.md) — CI workflows, release flow, branch/tag
  protection, allowed actions, secrets.
- [`signing.md`](signing.md) — commit-signing setup for human
  committers.
