# Security Policy

## Supported Versions

Only the latest published version of `@heal-dev/heal-playwright-tracer` receives security fixes.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | :white_check_mark: |
| < latest | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately through one of the following channels:

- **GitHub Private Vulnerability Reporting** — preferred. Open a report at
  https://github.com/heal-dev/heal-playwright-tracer/security/advisories/new
- **Email** — `security@heal.dev`

Please include:

- A description of the issue and the kind of impact you expect.
- Steps to reproduce (PoC, affected versions, environment).
- Any suggested mitigation, if known.

We aim to acknowledge reports within **3 business days** and to provide a
remediation plan or fix within **30 days** for high-severity issues. We will
coordinate a public disclosure date with you once a fix is available.

## Scope

In scope:

- Source code under `src/` and published package artifacts.
- Build, release, and CI workflows under `.github/workflows/`.
- Package supply-chain issues (e.g., compromised dependencies, tampered
  artifacts, malicious publication).

Out of scope:

- Vulnerabilities in third-party dependencies that are already publicly
  disclosed upstream — please report those to the upstream project.
- Social-engineering attacks against maintainers.
- Findings that require privileged access to a user's machine or CI.

## Safe Harbor

We will not pursue legal action against researchers who:

- Act in good faith and avoid privacy violations, data destruction, and
  service degradation.
- Give us a reasonable chance to remediate before public disclosure.
- Do not exploit the vulnerability beyond what is necessary to demonstrate it.
