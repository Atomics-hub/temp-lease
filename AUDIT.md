# Production audit

Audit date: 2026-09-02

## Result

`temp-lease@0.1.0` passed the complete local release command:

```bash
npm run verify
```

The live dependency audit reported zero known vulnerabilities.

## Verified surfaces

| Surface                      | Result                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Formatting and static lint   | Pass, zero warnings                                                                                           |
| Strict TypeScript            | Pass                                                                                                          |
| Behavioral tests             | 32 pass, 0 fail                                                                                               |
| Instrumented source coverage | 89.64% statements/lines, 81.67% branches, 96.49% functions                                                    |
| Name-parser fuzzing          | 10,000 unconstrained strings plus valid-name properties                                                       |
| Process-death recovery       | Real child process terminated with `SIGKILL`; orphan reaped                                                   |
| Reaper crash recovery        | Abandoned atomic claim recovered after its claimant died                                                      |
| Concurrency unit test        | 16 simultaneous reapers; exactly one claim                                                                    |
| Stress test                  | 1,000 create/dispose cycles; 500 orphans; 32 reapers; zero leaks/errors                                       |
| Filesystem safety            | Live-owner refusal, replacement preservation, root symlink/mode refusal, internal symlink target preservation |
| Recovery budgets             | Root entries, tree entries, reaps, concurrency, bytes, time, and abort                                        |
| Resumable large-tree cleanup | Bounded chunks queue and resume; former 10 GiB default ceiling regression covered                             |
| Transient filesystem errors  | Bounded retries, permanent-error refusal, and retry exhaustion covered                                        |
| Supported Node lines         | Node 20.20, 22.23, 24.20, and 26.8 ESM/CommonJS smoke pass                                                    |
| Type packaging               | Are The Types Wrong: all green; Publint: all good                                                             |
| Bundle budget                | ESM 5,920 bytes gzip; CommonJS 6,356 bytes gzip                                                               |
| Packed consumer              | Isolated ESM, CommonJS, and TypeScript consumers pass                                                         |
| Runtime dependencies         | None                                                                                                          |
| npm security audit           | Zero known vulnerabilities                                                                                    |

The audited artifact contains 12 allowlisted files and is about 38.8 kB compressed. Exact hashes and byte counts change with documentation or source-map updates.

## Safety cases covered

- private, per-user, versioned, namespace-specific roots;
- unique owner PID, PID namespace, and generation names created without a registration gap;
- live-owner refusal and dead-owner reclaim;
- namespace mismatch and unknown-namespace refusal;
- malformed, foreign, and non-directory refusal;
- atomic rename-before-remove with one winner under concurrency;
- interrupted-reaper recovery;
- ownerless queue continuation after entry, byte, or abort limits;
- in-flight bounded chunks finish after the pass deadline, guaranteeing progress;
- queue-transition failure rolls a claim back to a reclaimable name;
- incomplete automatic passes remain eligible for immediate continuation;
- identity receipt preservation of a same-name replacement;
- idempotent disposal and explicit keep semantics;
- symlink target non-traversal;
- deterministic truncation and detailed receipts at every budget;
- isolated package installation, ESM/CJS loading, and declaration consumption.

## Intentional boundaries

Recovery is eventual and requires a future process. Detached child intent is explicit through `keep()`. PID reuse biases toward retention. Same-user adversarial filesystem mutation, arbitrary temp files, and operating-system storage policy are out of scope.

## Remaining launch gate

The repository includes a 12-job Linux/macOS/Windows by Node 20/22/24/26 CI matrix. This local audit ran on macOS; the hosted cross-platform matrix must be green before npm publication.
