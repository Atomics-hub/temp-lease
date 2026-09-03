# Changelog

All notable changes to this project will be documented here.

## 0.1.0 - Unreleased

- Add private per-user and per-namespace temporary workspace roots.
- Add explicit, identity-preserving disposal and `Symbol.asyncDispose` support.
- Add dead-owner recovery with Linux PID-namespace binding and fail-closed liveness checks.
- Add atomic claims, concurrent-reaper safety, and recovery of interrupted reaping.
- Add explicit `keep()` for detached ownership and persistent results.
- Add entry, reap, byte, tree, time, and abort budgets with detailed receipts.
- Ship ESM, CommonJS, and TypeScript declarations with no runtime dependencies.
