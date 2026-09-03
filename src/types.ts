export interface TempLeaseLocationOptions {
  /** Logical isolation boundary. Different namespaces never reap one another. */
  namespace?: string;
  /** Directory under which temp-lease creates its private, versioned root. */
  baseDirectory?: string;
}

export interface ReapBudgets {
  /** Maximum direct children inspected in one pass. Default: 1,000. */
  maxEntries?: number;
  /** Maximum workspace chunks claimed in one pass. Default: 100. */
  maxReaps?: number;
  /** Maximum workspace chunks removed concurrently. Default: 4. */
  maxConcurrency?: number;
  /** Maximum logical file bytes removed in one pass. Default: MAX_SAFE_INTEGER. */
  maxBytes?: number;
  /** Maximum entries visited inside any one workspace per chunk. Default: 100,000. */
  maxTreeEntries?: number;
  /** Stop recovery work after this many milliseconds. Default: 2,000. */
  maxDurationMs?: number;
  /** Retries for transient filesystem operation failures. Default: 3. */
  maxRetries?: number;
  /** Linear retry delay in milliseconds. Default: 100. */
  retryDelayMs?: number;
}

export interface ReapTempLeasesOptions
  extends TempLeaseLocationOptions, ReapBudgets {
  signal?: AbortSignal;
}

export interface CreateTempLeaseOptions extends TempLeaseLocationOptions {
  /**
   * Run one bounded recovery pass per namespace and process. Pass a budget
   * object to override defaults, or false to opt out. Default: true.
   */
  reap?: boolean | ReapBudgets;
  signal?: AbortSignal;
}

export type ReapSkipReason =
  | "aborted"
  | "entry-budget"
  | "foreign"
  | "live-owner"
  | "namespace-unknown"
  | "namespace-mismatch"
  | "not-directory"
  | "race-lost"
  | "time-budget"
  | "unknown-owner";

export interface ReapedEntry {
  name: string;
  kind: "lease" | "abandoned-reap" | "continued-reap";
  bytes: number;
  entries: number;
}

export interface ProgressedEntry {
  name: string;
  queuedName: string;
  reason: "aborted" | "byte-budget" | "entry-budget" | "time-budget";
  bytes: number;
  entries: number;
}

export interface SkippedEntry {
  name: string;
  reason: ReapSkipReason;
}

export interface ReapError {
  name: string;
  operation: "claim" | "queue" | "remove";
  code?: string;
  message: string;
}

export interface ReapReport {
  root: string;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  removedBytes: number;
  reaped: ReapedEntry[];
  progressed: ProgressedEntry[];
  skipped: SkippedEntry[];
  errors: ReapError[];
  truncated: boolean;
}

export interface DisposeReceipt {
  path: string;
  status: "removed" | "already-absent" | "identity-changed" | "kept";
  /** Replacement preserved under a new unowned name after a claim-time race. */
  preservedPath?: string;
}

export interface KeepReceipt {
  previousPath: string;
  path: string;
  status: "kept" | "already-kept";
}

export interface TempLease {
  readonly path: string;
  readonly root: string;
  readonly recovery: ReapReport | undefined;
  readonly disposed: boolean;
  readonly kept: boolean;
  dispose(): Promise<DisposeReceipt>;
  /**
   * Atomically moves the workspace to an unowned name so recovery will never
   * remove it. The returned path may differ from the original path.
   */
  keep(): Promise<KeepReceipt>;
  [Symbol.asyncDispose](): Promise<void>;
}
