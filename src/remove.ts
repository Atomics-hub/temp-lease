import { lstat, opendir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

const RETRYABLE_CODES = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  retryDelayMs: number,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= maxRetries ||
        !RETRYABLE_CODES.has(errorCode(error) ?? "")
      ) {
        throw error;
      }
      attempt += 1;
      await wait(retryDelayMs * attempt);
    }
  }
}

export async function removeRecursively(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

export type RemovalStopReason = "aborted" | "byte-budget" | "entry-budget";

export interface IncrementalRemovalOptions {
  maxEntries: number;
  signal?: AbortSignal;
  maxRetries: number;
  retryDelayMs: number;
  reserveBytes(bytes: number): boolean;
}

export interface IncrementalRemovalResult {
  complete: boolean;
  removedRoot: boolean;
  reason?: RemovalStopReason;
  removedBytes: number;
  visitedEntries: number;
}

interface PathFrame {
  path: string;
  expanded: boolean;
  incompleteEnumeration?: boolean;
}

function stopped(
  options: IncrementalRemovalOptions,
): RemovalStopReason | undefined {
  if (options.signal?.aborted) return "aborted";
  return undefined;
}

/**
 * Removes a bounded post-order chunk without following symlinks. The root may
 * remain partially populated; callers retain ownership until they rename it
 * back to a queued state.
 */
export async function removeIncrementally(
  root: string,
  options: IncrementalRemovalOptions,
): Promise<IncrementalRemovalResult> {
  const stack: PathFrame[] = [{ path: root, expanded: false }];
  let scheduledPaths = 1;
  let removedRoot = false;
  let removedBytes = 0;
  let visitedEntries = 0;

  const incomplete = (reason: RemovalStopReason): IncrementalRemovalResult => ({
    complete: false,
    removedRoot,
    reason,
    removedBytes,
    visitedEntries,
  });

  while (stack.length > 0) {
    const stopReason = stopped(options);
    if (stopReason) return incomplete(stopReason);

    const frame = stack.pop()!;
    if (frame.expanded) {
      if (frame.incompleteEnumeration) return incomplete("entry-budget");
      try {
        await retryOperation(
          () => rmdir(frame.path),
          options.maxRetries,
          options.retryDelayMs,
        );
        if (frame.path === root) removedRoot = true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        if (errorCode(error) === "ENOTEMPTY") {
          return incomplete("entry-budget");
        }
        throw error;
      }
      continue;
    }

    scheduledPaths -= 1;
    if (visitedEntries >= options.maxEntries) {
      return incomplete("entry-budget");
    }

    let stats;
    try {
      stats = await lstat(frame.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    visitedEntries += 1;

    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      const children: string[] = [];
      let incompleteEnumeration = false;
      const directory = await opendir(frame.path);
      try {
        for await (const entry of directory) {
          const duringEnumeration = stopped(options);
          if (duringEnumeration) return incomplete(duringEnumeration);
          if (
            visitedEntries + scheduledPaths + children.length >=
            options.maxEntries
          ) {
            incompleteEnumeration = true;
            break;
          }
          children.push(join(frame.path, entry.name));
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      stack.push({ path: frame.path, expanded: true, incompleteEnumeration });
      for (const child of children) {
        stack.push({ path: child, expanded: false });
      }
      scheduledPaths += children.length;
      continue;
    }

    if (!options.reserveBytes(stats.size)) {
      return incomplete("byte-budget");
    }
    await retryOperation(
      () => rm(frame.path, { force: true }),
      options.maxRetries,
      options.retryDelayMs,
    );
    if (frame.path === root) removedRoot = true;
    removedBytes += stats.size;
  }

  return { complete: true, removedRoot, removedBytes, visitedEntries };
}
