import type { Dirent } from "node:fs";
import { opendir, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseOwnedName, queuedName, reapingName } from "./names.js";
import { ownerState, processNamespace } from "./platform.js";
import { removeIncrementally, retryOperation } from "./remove.js";
import { ensureTempLeaseRoot } from "./root.js";
import type {
  ReapError,
  ReapReport,
  ReapSkipReason,
  ReapTempLeasesOptions,
} from "./types.js";

interface Budgets {
  maxEntries: number;
  maxReaps: number;
  maxConcurrency: number;
  maxBytes: number;
  maxTreeEntries: number;
  maxDurationMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

function finiteBudget(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return result;
}

function budgets(options: ReapTempLeasesOptions): Budgets {
  return {
    maxEntries: finiteBudget(options.maxEntries, 1_000, "maxEntries"),
    maxReaps: finiteBudget(options.maxReaps, 100, "maxReaps"),
    maxConcurrency: finiteBudget(options.maxConcurrency, 4, "maxConcurrency"),
    maxBytes: finiteBudget(
      options.maxBytes,
      Number.MAX_SAFE_INTEGER,
      "maxBytes",
    ),
    maxTreeEntries: finiteBudget(
      options.maxTreeEntries,
      100_000,
      "maxTreeEntries",
    ),
    maxDurationMs: finiteBudget(options.maxDurationMs, 2_000, "maxDurationMs"),
    maxRetries: finiteBudget(options.maxRetries, 3, "maxRetries"),
    retryDelayMs: finiteBudget(options.retryDelayMs, 100, "retryDelayMs"),
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function receiptError(
  name: string,
  operation: ReapError["operation"],
  error: unknown,
): ReapError {
  const code = errorCode(error);
  return {
    name,
    operation,
    ...(code === undefined ? {} : { code }),
    message: error instanceof Error ? error.message : String(error),
  };
}

function skip(report: ReapReport, name: string, reason: ReapSkipReason): void {
  report.skipped.push({ name, reason });
}

export async function reapTempLeases(
  options: ReapTempLeasesOptions = {},
): Promise<ReapReport> {
  const limit = budgets(options);
  if (limit.maxConcurrency === 0) {
    throw new RangeError("maxConcurrency must be greater than zero");
  }

  const started = new Date();
  const deadline = Date.now() + limit.maxDurationMs;
  const root = await ensureTempLeaseRoot(options);
  const namespace = await processNamespace();
  const report: ReapReport = {
    root,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    scanned: 0,
    removedBytes: 0,
    reaped: [],
    progressed: [],
    skipped: [],
    errors: [],
    truncated: false,
  };

  let remainingBytes = limit.maxBytes;
  let reservedReaps = 0;

  const releaseClaim = async (
    entryName: string,
    claimed: string,
    source: string,
    destination: string,
  ): Promise<boolean> => {
    try {
      await retryOperation(
        () => rename(claimed, destination),
        limit.maxRetries,
        limit.retryDelayMs,
      );
      return true;
    } catch (error) {
      report.errors.push(receiptError(entryName, "queue", error));
      try {
        await retryOperation(
          () => rename(claimed, source),
          limit.maxRetries,
          limit.retryDelayMs,
        );
      } catch (rollbackError) {
        report.errors.push(receiptError(entryName, "queue", rollbackError));
      }
      return false;
    }
  };

  const processEntry = async (entry: Dirent): Promise<void> => {
    if (options.signal?.aborted) {
      skip(report, entry.name, "aborted");
      report.truncated = true;
      return;
    }
    if (Date.now() >= deadline) {
      skip(report, entry.name, "time-budget");
      report.truncated = true;
      return;
    }

    const parsed = parseOwnedName(entry.name);
    if (!parsed) {
      skip(report, entry.name, "foreign");
      return;
    }
    if (!entry.isDirectory()) {
      skip(report, entry.name, "not-directory");
      return;
    }
    if (namespace === "unknown" || parsed.namespace === "unknown") {
      skip(report, entry.name, "namespace-unknown");
      return;
    }
    if (namespace !== parsed.namespace) {
      skip(report, entry.name, "namespace-mismatch");
      return;
    }

    if (parsed.kind !== "queued") {
      const responsiblePid =
        parsed.kind === "lease" ? parsed.ownerPid : parsed.reaperPid;
      const state = ownerState(responsiblePid);
      if (state === "alive") {
        skip(report, entry.name, "live-owner");
        return;
      }
      if (state === "unknown") {
        skip(report, entry.name, "unknown-owner");
        return;
      }
    }

    if (reservedReaps >= limit.maxReaps) {
      skip(report, entry.name, "entry-budget");
      report.truncated = true;
      return;
    }
    reservedReaps += 1;

    const source = join(root, entry.name);
    const claimedName = reapingName(
      parsed.ownerPid,
      namespace,
      parsed.generation,
    );
    const claimed = join(root, claimedName);
    try {
      await retryOperation(
        () => rename(source, claimed),
        limit.maxRetries,
        limit.retryDelayMs,
      );
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        skip(report, entry.name, "race-lost");
      } else {
        report.errors.push(receiptError(entry.name, "claim", error));
      }
      return;
    }

    let removal;
    try {
      removal = await removeIncrementally(claimed, {
        maxEntries: limit.maxTreeEntries,
        deadline,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxRetries: limit.maxRetries,
        retryDelayMs: limit.retryDelayMs,
        reserveBytes(bytes) {
          if (bytes > remainingBytes) return false;
          remainingBytes -= bytes;
          return true;
        },
      });
    } catch (error) {
      report.errors.push(receiptError(entry.name, "remove", error));
      report.truncated = true;
      const queued = join(
        root,
        queuedName(parsed.ownerPid, namespace, parsed.generation),
      );
      await releaseClaim(entry.name, claimed, source, queued);
      return;
    }

    report.removedBytes += removal.removedBytes;
    if (removal.complete) {
      report.reaped.push({
        name: entry.name,
        kind:
          parsed.kind === "lease"
            ? "lease"
            : parsed.kind === "reaping"
              ? "abandoned-reap"
              : "continued-reap",
        bytes: removal.removedBytes,
        entries: removal.visitedEntries,
      });
      return;
    }

    const nextQueuedName = queuedName(
      parsed.ownerPid,
      namespace,
      parsed.generation,
    );
    report.truncated = true;
    if (
      await releaseClaim(
        entry.name,
        claimed,
        source,
        join(root, nextQueuedName),
      )
    ) {
      report.progressed.push({
        name: entry.name,
        queuedName: nextQueuedName,
        reason: removal.reason!,
        bytes: removal.removedBytes,
        entries: removal.visitedEntries,
      });
    }
  };

  const directory = await opendir(root);
  const active = new Set<Promise<void>>();
  try {
    for await (const entry of directory) {
      if (report.scanned >= limit.maxEntries) {
        report.truncated = true;
        break;
      }
      report.scanned += 1;

      const task = processEntry(entry).finally(() => active.delete(task));
      active.add(task);
      if (active.size >= limit.maxConcurrency) {
        await Promise.race(active);
      }
    }
    await Promise.all(active);
  } finally {
    await directory.close().catch(() => undefined);
    report.finishedAt = new Date().toISOString();
  }

  return report;
}
