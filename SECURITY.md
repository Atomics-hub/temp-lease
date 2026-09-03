# Security policy

## Supported versions

The latest published minor version receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for `Atomics-hub/temp-lease` and include the affected version, operating system and filesystem, impact, and a minimal reproduction.

We aim to acknowledge reports within 72 hours. Confirmed issues will receive a coordinated fix and advisory before public technical details are discussed.

## Trust model

`temp-lease` is a conservative lifecycle primitive, not a same-user security sandbox.

- It operates only below its deterministic private root and recognizes only its exact versioned child-name grammar.
- On Unix, both package and namespace roots must be owned by the current uid with `0700` permissions. Symlink roots are rejected.
- Linux recovery requires the recorded and current PID-namespace fingerprints to match.
- An owner is dead only when the OS liveness probe returns `ESRCH`. `EPERM` and every other error are unknown and fail closed.
- Recursive measurement and removal use `lstat`; symlinks inside a workspace are removed as links and are not traversed.
- Normal disposal compares the directory's device, inode, and birth-time receipt before claiming it.

A hostile process with the same OS account can inspect memory, replace filesystem objects, signal peer processes, and manufacture names. Preventing that requires separate OS users, containers, or another isolation boundary and is intentionally outside this package's claims.

## Operational guidance

- Give unrelated applications distinct namespaces.
- Do not place untrusted manually named directories inside a temp-lease root.
- Inspect `errors`, `skipped`, and `truncated` in explicit recovery reports.
- Raise budgets only for roots whose storage growth you understand.
- Call `keep()` before a detached child or external process takes responsibility for the workspace.
