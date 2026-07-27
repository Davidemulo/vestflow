# Contributing to VestFlow

Thank you for your interest in contributing! VestFlow is a Stellar/Soroban token vesting protocol — contributions to the smart contract, frontend, tests, and documentation are all welcome.

## Getting started

1. Fork the repository and clone your fork.
2. Install prerequisites: Node.js ≥ 18, Rust, `wasm32v1-none` target, Stellar CLI, Freighter wallet.
3. Run `npm install` in the project root.
4. Run `cargo test` inside `contracts/vestflow/` to verify the contract tests pass.
5. Run `npm run dev` and open `http://localhost:3000` to verify the frontend builds.

## Ways to contribute

- **Bug reports** — open an issue describing the behaviour, what you expected, and steps to reproduce.
- **Feature requests** — open an issue with the `enhancement` label. Discuss before implementing.
- **Good first issues** — issues labelled [`good first issue`](https://github.com/libby-coder/vestflow/issues?q=label%3A%22good+first+issue%22) are scoped and well-described — a great place to start.
- **Documentation** — typo fixes, clarifications, and new examples are always appreciated.
- **Tests** — additional test cases for edge cases in the contract are valuable.

## Pull request guidelines

- Keep each PR focused on one thing.
- For contract changes: add or update tests in `contracts/vestflow/src/lib.rs`. All tests must pass (`cargo test`).
- For frontend changes: make sure `npm run build` succeeds without TypeScript errors.
- Write a clear PR description explaining what changed and why.
- Reference any related issue with `Closes #<number>`.

## Contract development notes

The Soroban contract targets `wasm32v1-none` and uses `soroban-sdk` v22.

```bash
# Run tests
cd contracts/vestflow
cargo test

# Build WASM
cargo build --target wasm32v1-none --release

# Deploy to testnet (requires stellar CLI + funded key)
stellar contract deploy \
  --wasm target/wasm32v1-none/release/vestflow.wasm \
  --source your-key \
  --network testnet
```

## Code style

- Rust: follow standard `rustfmt` formatting (`cargo fmt`).
- TypeScript: linted with ESLint (`npm run lint`), enforced in CI.
- Comments: only when the *why* is non-obvious.

## Reviewing Dependabot security PRs

Contributors who triage or review a Dependabot security-alert PR should check:

- [ ] **Changelog / release notes** — read the changelog between the old and new version for the affected package. Confirm the fix actually addresses the advisory, not an unrelated release.
- [ ] **Breaking changes** — check for a major version bump or any noted breaking API changes. If the bump crosses a major version, verify the codebase doesn't use any removed/changed APIs.
- [ ] **License compatibility** — confirm the new version's license hasn't changed in a way that's incompatible with this project's MIT license.
- [ ] **Transitive scope** — check whether the update also pulls in changes to transitive dependencies (visible in the lockfile diff) beyond the flagged package.
- [ ] **CI is green** — do not merge on the advisory's urgency alone; let `npm ci && npm run build && npm test` (and `cargo test` for contract-adjacent updates) run and pass first.
- [ ] **Advisory severity vs. actual exposure** — a "critical" advisory in a devDependency or a code path this project doesn't use is lower real risk than the CVSS score alone suggests; note this in the PR review if relevant.

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities. Email the maintainer directly so the issue can be addressed before public disclosure.
