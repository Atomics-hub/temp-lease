# Changelog

All notable changes to this project will be documented here.

## 0.1.0 - 2026-09-02

- Add private per-user and per-namespace temporary workspace roots.
- Add explicit, identity-preserving disposal and `Symbol.asyncDispose` support.
- Add dead-owner recovery with Linux PID-namespace binding and fail-closed liveness checks.
- Add atomic claims, concurrent-reaper safety, and recovery of interrupted reaping.
- Add explicit `keep()` for detached ownership and persistent results.
- Add entry, reap, byte, tree, time, and abort budgets with detailed receipts.
- Make oversized cleanup resumable through atomic ownerless queue entries.
- Retry transient claim and removal failures with bounded configurable backoff.
- Retry incomplete automatic recovery instead of caching partial passes.
- Preserve the claimed handle path when a post-rename inspection fails.
- Guarantee forward progress when a claimed chunk crosses the pass deadline.
- Report only the successful root remover as the winner of a Windows rename race.
- Ship ESM, CommonJS, and TypeScript declarations with no runtime dependencies.
