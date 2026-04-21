# Publishing to npm

This package is published publicly to the npm registry as [`@heal-dev/heal-playwright-tracer`](https://www.npmjs.com/package/@heal-dev/heal-playwright-tracer).

Because the package name is scoped (`@heal-dev/...`), publishing requires `--access public` — without it, npm defaults scoped packages to private and rejects the publish.

## Bump the version

Use `npm version` to update `package.json`, create a commit, and tag the release in one step. Pick the bump type that matches the change:

```bash
npm version patch     # 1.0.0 -> 1.0.1 (bug fixes)
npm version minor     # 1.0.0 -> 1.1.0 (backwards-compatible features)
npm version major     # 1.0.0 -> 2.0.0 (breaking changes)
```

This creates a commit like `v1.0.1` and a matching git tag.

## Publish

Log in to npm with an account that belongs to the `heal-dev` organization:

```bash
npm login
npm whoami            # confirm the active user
```

Then publish:

```bash
npm publish --access public
```

The `prepublishOnly` script runs `npm run build` automatically, so `dist/` is rebuilt before the tarball is uploaded. Only files listed in the `files` field of `package.json` (currently `dist/` and `README.md`) are included.

## Push the release

Push the version commit and the tag to GitHub:

```bash
git push origin main --follow-tags
```

## Verify

```bash
npm view @heal-dev/heal-playwright-tracer version
npm view @heal-dev/heal-playwright-tracer dist-tags
```
