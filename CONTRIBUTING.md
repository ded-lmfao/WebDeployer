# Contributing to WebDep

Thank you for your interest in contributing to **WebDep**. Please read these
guidelines before opening an issue or submitting a pull request.

By participating in this project, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Reporting Bugs & Suggesting Features

- Use the structured [Issue Templates](https://github.com/ded-lmfao/WebDep/issues/new/choose)
  for bug reports and feature requests.
- **Do not report security vulnerabilities in public issues.** Follow
  [SECURITY.md](SECURITY.md) to report them privately.

---

## Local Development Setup

### Prerequisites

- **Rust toolchain** (stable) + Cargo
- **Node.js** (only needed if syntax-checking `public/` JavaScript modules or
  working on the separate `website` branch)
- Optional runtime dependencies for end-to-end testing: `git`, `postgresql`,
  `caddy`

### Build & Run

```bash
git clone https://github.com/ded-lmfao/WebDep.git
cd WebDep
cargo build --locked
cargo run --locked
```

The control plane defaults to `http://0.0.0.0:4600` (configurable via `.env`;
see [README.md](README.md#configuration)).

---

## Verification Before Submitting a PR

Run all relevant checks locally before pushing:

```bash
# 1. Type-check all targets
cargo check --all-targets --locked

# 2. Run Rust unit and integration tests
cargo test --no-fail-fast --locked

# 3. Verify frontend module syntax if you edited files under public/
node --check public/app.js
```

Releases on `main` are gated on CI tests and the **SonarCloud Quality Gate**, so
keep new code clean of lint warnings, unsafe regex backtracking, and unhandled
promises.

---

## Commit & Release Conventions

Pushes to `main` trigger automated release evaluation in
[`.github/workflows/release.yml`](.github/workflows/release.yml):

| Commit Message Keyword / Prefix | CI Release Effect |
| :--- | :--- |
| Default commit | Bumps **patch** (`vX.Y.Z` -> `vX.Y.Z+1`) if SonarCloud passes |
| `feat:` / `[minor]` / `minor:` | Bumps **minor** (`vX.Y.0`) |
| `feat!:` / `BREAKING CHANGE:` / `[major]` / `major:` | Bumps **major** (`vX.0.0`) |
| `docs:` / `chore(docs):` / `[docs]` / `[skip release]` | Skips building/cutting a release |

When opening documentation-only PRs or commits, include `docs:` or
`[skip release]` so CI does not publish an unnecessary binary release.

---

## Branch Structure

- `main`: Rust control plane, embedded frontend (`public/`), and release workflows.
- `website`: Static GitHub Pages documentation and showcase site.

---

## Pull Request Checklist

1. Keep PRs focused on a single bug fix, feature, or documentation update.
2. Preserve existing comments and avoid duplicating helpers across modules.
3. Add or update unit/integration tests for backend behavior changes.
4. Fill out the [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).
