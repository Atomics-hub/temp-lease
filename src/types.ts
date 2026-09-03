export interface TempLeaseLocationOptions {
  /** Logical isolation boundary. Different namespaces never reap one another. */
  namespace?: string;
  /** Directory under which temp-lease creates its private, versioned root. */
  baseDirectory?: string;
}

export interface ReapBudgets {
  /** Maximum direct children inspected in one pass. Default: 1,000. */
  maxEntries?: number;
  /** Maximum workspaces removed in one pass. Default: 100. */
  maxReaps?: number;
  /** Maximum workspaces measured/removed concurrently. Default: 4. */
  maxConcurrency?: number;
  /** Maximum measured bytes removed in one pass. Default: 10 GiB. */
  maxBytes?: number;
  /** Maximum entries measured inside any one workspace. Default: 100,000. */
  maxTreeEntries?: number;
  /** Stop starting new work after this many milliseconds. Default: 2,000. */
  maxDurationMs?: number;
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
  | "byte-budget"
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
  kind: "lease" | "abandoned-reap";
  bytes: number;
}

export interface SkippedEntry {
  name: string;
  reason: ReapSkipReason;
}

export interface ReapError {
  name: string;
  operation: "measure" | "claim" | "remove";
  code?: string;
  message: string;
}

export interface ReapReport {
  root: string;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  measuredBytes: number;
  reaped: ReapedEntry[];
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
