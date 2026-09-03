import type { Dirent } from "node:fs";
import { lstat, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseOwnedName, reapingName } from "./names.js";
import { ownerState, processNamespace } from "./platform.js";
import { ensureTempLeaseRoot } from "./root.js";
import type {
  ReapError,
  ReapReport,
  ReapSkipReason,
  ReapTempLeasesOptions,
} from "./types.js";

const GIB = 1024 ** 3;

interface Budgets {
  maxEntries: number;
  maxReaps: number;
  maxConcurrency: number;
  maxBytes: number;
  maxTreeEntries: number;
  maxDurationMs: number;
}

interface Measurement {
  bytes: number;
  entries: number;
  exceededEntries: boolean;
  timedOut: boolean;
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
    maxBytes: finiteBudget(options.maxBytes, 10 * GIB, "maxBytes"),
    maxTreeEntries: finiteBudget(
      options.maxTreeEntries,
      100_000,
      "maxTreeEntries",
    ),
    maxDurationMs: finiteBudget(options.maxDurationMs, 2_000, "maxDurationMs"),
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

async function measureTree(
  root: string,
  maxEntries: number,
  deadline: number,
): Promise<Measurement> {
  const pending = [root];
  let bytes = 0;
  let entries = 0;

  while (pending.length > 0) {
    if (Date.now() >= deadline) {
      return { bytes, entries, exceededEntries: false, timedOut: true };
    }
    const path = pending.pop()!;
    const stats = await lstat(path);
    entries += 1;
    bytes += stats.size;
    if (entries > maxEntries) {
      return { bytes, entries, exceededEntries: true, timedOut: false };
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    const directory = await opendir(path);
    try {
      for await (const entry of directory) {
        if (Date.now() >= deadline) {
          return { bytes, entries, exceededEntries: false, timedOut: true };
        }
        if (entries + pending.length >= maxEntries) {
          return { bytes, entries, exceededEntries: true, timedOut: false };
        }
        pending.push(join(path, entry.name));
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return { bytes, entries, exceededEntries: false, timedOut: false };
}

function skip(report: ReapReport, name: string, reason: ReapSkipReason): void {
  report.skipped.push({ name, reason });
}

export async function reapTempLeases(
  options: ReapTempLeasesOptions = {},
): Promise<ReapReport> {
  const limit = budgets(options);
  const started = new Date();
  const deadline = Date.now() + limit.maxDurationMs;
  const root = await ensureTempLeaseRoot(options);
  const namespace = await processNamespace();
  const report: ReapReport = {
    root,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    scanned: 0,
    measuredBytes: 0,
    reaped: [],
    skipped: [],
    errors: [],
    truncated: false,
  };

  if (limit.maxConcurrency === 0) {
    throw new RangeError("maxConcurrency must be greater than zero");
  }

  let reservedBytes = 0;
  let reservedReaps = 0;

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

    const source = join(root, entry.name);
    let measurement: Measurement;
    try {
      measurement = await measureTree(source, limit.maxTreeEntries, deadline);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        skip(report, entry.name, "race-lost");
      } else {
        report.errors.push(receiptError(entry.name, "measure", error));
      }
      return;
    }
    report.measuredBytes += measurement.bytes;
    if (measurement.exceededEntries) {
      skip(report, entry.name, "entry-budget");
      return;
    }
    if (measurement.timedOut) {
      skip(report, entry.name, "time-budget");
      report.truncated = true;
      return;
    }
    if (reservedReaps >= limit.maxReaps) {
      skip(report, entry.name, "entry-budget");
      report.truncated = true;
      return;
    }
    if (measurement.bytes > limit.maxBytes - reservedBytes) {
      skip(report, entry.name, "byte-budget");
      return;
    }
    reservedReaps += 1;
    reservedBytes += measurement.bytes;

    const claimedName = reapingName(
      parsed.ownerPid,
      namespace,
      parsed.generation,
    );
    const claimed = join(root, claimedName);
    try {
      await rename(source, claimed);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        skip(report, entry.name, "race-lost");
      } else {
        report.errors.push(receiptError(entry.name, "claim", error));
      }
      return;
    }

    try {
      await rm(claimed, { recursive: true, force: true });
      report.reaped.push({
        name: entry.name,
        kind: parsed.kind === "lease" ? "lease" : "abandoned-reap",
        bytes: measurement.bytes,
      });
    } catch (error) {
      report.errors.push(receiptError(entry.name, "remove", error));
      await rename(claimed, source).catch(() => undefined);
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
