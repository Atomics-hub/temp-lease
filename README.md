# temp-lease

Crash-recoverable temporary workspaces for Node.js.

[![npm version](https://img.shields.io/npm/v/temp-lease.svg)](https://www.npmjs.com/package/temp-lease)
[![CI](https://github.com/Atomics-hub/temp-lease/actions/workflows/ci.yml/badge.svg)](https://github.com/Atomics-hub/temp-lease/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/temp-lease.svg)](LICENSE)

`finally` and process-exit hooks cannot run after `SIGKILL`, OOM termination, a native crash, or power loss. `temp-lease` makes that failure recoverable: a later process removes only workspaces created by this package whose owning process is conclusively dead.

```bash
npm install temp-lease
```

```ts
import { tempLease } from "temp-lease";

const workspace = await tempLease({ namespace: "my-downloader" });

try {
  await downloadAndExtract(url, workspace.path);
} finally {
  await workspace.dispose();
}
```

That looks like ordinary temp-directory cleanup—and it is. The difference appears when the process cannot reach `finally`: the next `tempLease()` call in the same namespace runs one bounded recovery pass before creating a new workspace.

## Why this exists

| Approach               | Normal cleanup | Recovers after process death | Proves the owner is dead | Refuses foreign names |
| ---------------------- | -------------- | ---------------------------- | ------------------------ | --------------------- |
| `fs.mkdtemp()`         | Caller-owned   | No                           | No                       | N/A                   |
| Exit-hook temp helpers | Yes            | No                           | No                       | Varies                |
| Age-based reapers      | Eventually     | Yes                          | No—age is a guess        | Varies                |
| `temp-lease`           | Yes            | Yes, on a later run          | Yes, or skips            | Yes                   |

No age threshold is involved. A live owner is never reaped merely because a job is slow.

## API

### `tempLease(options?)`

Creates a private directory and returns a `TempLease` handle. `createTempLease` is an alias.

```ts
const lease = await tempLease({
  namespace: "electron-downloads",
  baseDirectory: "/optional/temp/volume",
  reap: {
    maxEntries: 1_000,
    maxReaps: 100,
    maxConcurrency: 4,
    maxBytes: 10 * 1024 ** 3,
    maxTreeEntries: 100_000,
    maxDurationMs: 2_000,
  },
  signal,
});
```

- `namespace` isolates unrelated consumers. It is hashed before becoming a directory name. Default: `"default"`.
- `baseDirectory` chooses the parent of the package's private root. Default: `os.tmpdir()`.
- `reap` is `true`, `false`, or a budget object. Default: `true`.
- `signal` can stop creation before the directory is allocated and stops recovery from starting more work.

Automatic recovery is deduplicated across concurrent and repeated creation in a namespace. The completed-root cache is capped at 1,024 entries, so an older namespace may be scanned again; that is safe. Call `reapTempLeases()` directly whenever you want another pass.

### `lease.dispose()`

Atomically claims and removes the workspace. The handle records its filesystem identity; if the path disappeared and was recreated, the replacement is preserved and the receipt reports `identity-changed`.

```ts
const receipt = await lease.dispose();
// { path, status: "removed" | "already-absent" | "identity-changed" | "kept" }
```

Disposal is idempotent. The handle also implements `Symbol.asyncDispose` where your runtime supports explicit resource management.

### `lease.keep()`

Use `keep()` before a detached child must outlive its parent, or when the result should persist.

```ts
const { path } = await lease.keep();
// Pass this returned path onward: keep() atomically renames the directory.
```

The new `kept-v1-*` name is outside the recovery protocol. `temp-lease` will not remove it later. The caller owns its eventual cleanup.

### `reapTempLeases(options?)`

Runs a bounded recovery pass and returns a complete receipt.

```ts
const report = await reapTempLeases({ namespace: "my-downloader" });

console.log(report.reaped);
console.log(report.skipped); // live, unknown, foreign, over-budget, raced...
console.log(report.errors); // inspect, measure, claim, or removal failures
```

Defaults per pass:

- inspect at most 1,000 direct children;
- remove at most 100 workspaces;
- measure/remove at most 4 workspaces concurrently;
- remove at most 10 GiB of measured contents;
- measure at most 100,000 entries per workspace;
- stop starting new work after 2 seconds.

Removal already in progress may finish after the time deadline. Raise budgets deliberately for unusually large artifact trees.

### `getTempLeaseRoot(options?)`

Returns the deterministic root path without creating it. This is useful for diagnostics; application code should not write its own entries there.

## Recovery protocol

1. Every workspace is a direct child of a private `0700`, per-user, versioned, namespace-specific root.
2. Its name contains the owner PID, current PID-namespace fingerprint on Linux, and 128 bits of randomness before the path is returned.
3. Recovery accepts only that exact name grammar and only real directories.
4. `process.kill(pid, 0)` checks liveness. `EPERM`, an unreadable namespace, and any ambiguous result fail closed.
5. A dead-owner directory is renamed within the same root before deletion. That atomic claim prevents two reapers from owning it.
6. The claim itself records the reaper PID. If that process dies during deletion, a later process can recover the abandoned claim.

PID reuse produces a safe false negative: an old workspace waits while an unrelated process holds the same PID. It does not produce a wrongful deletion.

## Boundaries

`temp-lease` deliberately does **not**:

- promise cleanup if no later process ever runs;
- scan or delete arbitrary pre-existing temp files;
- infer whether detached children still need a directory—call `keep()` explicitly;
- treat age, mtime, or a timeout as proof that a workspace is abandoned;
- cross a Linux PID namespace it cannot identify;
- defend against an adversarial process running as the same OS user;
- replace operating-system, VM, or container retention policies.

See [SECURITY.md](SECURITY.md) for the trust model and [AUDIT.md](AUDIT.md) for the release evidence.

## Requirements

- Node.js 20 or newer
- Linux, macOS, or Windows
- No runtime dependencies

## License

MIT
