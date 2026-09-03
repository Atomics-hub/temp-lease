import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TempLeaseStateError } from "./errors.js";
import { generationToken, keptName, leaseName, reapingName } from "./names.js";
import { directoryIdentity, sameIdentity } from "./identity.js";
import { processNamespace } from "./platform.js";
import { reapTempLeases } from "./reap.js";
import { ensureTempLeaseRoot } from "./root.js";
import type {
  CreateTempLeaseOptions,
  DisposeReceipt,
  KeepReceipt,
  ReapReport,
  ReapTempLeasesOptions,
  TempLease,
} from "./types.js";

export {
  TempLeaseError,
  TempLeaseRootError,
  TempLeaseStateError,
} from "./errors.js";
export { getTempLeaseRoot } from "./root.js";
export { reapTempLeases } from "./reap.js";
export type {
  CreateTempLeaseOptions,
  DisposeReceipt,
  KeepReceipt,
  ReapBudgets,
  ReapedEntry,
  ReapError,
  ReapReport,
  ReapSkipReason,
  ReapTempLeasesOptions,
  SkippedEntry,
  TempLease,
  TempLeaseLocationOptions,
} from "./types.js";

const recoveryInFlight = new Map<string, Promise<ReapReport>>();
const recoveredRoots = new Map<string, true>();
const MAX_RECOVERED_ROOTS = 1_024;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

async function recoverOnce(
  options: CreateTempLeaseOptions,
  root: string,
): Promise<ReapReport | undefined> {
  if (options.reap === false) return undefined;
  if (recoveredRoots.has(root)) {
    recoveredRoots.delete(root);
    recoveredRoots.set(root, true);
    return undefined;
  }
  const configured = typeof options.reap === "object" ? options.reap : {};
  const reapOptions: ReapTempLeasesOptions = {
    ...configured,
    ...(options.namespace === undefined
      ? {}
      : { namespace: options.namespace }),
    ...(options.baseDirectory === undefined
      ? {}
      : { baseDirectory: options.baseDirectory }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  let recovery = recoveryInFlight.get(root);
  if (!recovery) {
    recovery = reapTempLeases(reapOptions);
    recoveryInFlight.set(root, recovery);
  }
  try {
    const report = await recovery;
    if (!options.signal?.aborted) {
      recoveredRoots.set(root, true);
      if (recoveredRoots.size > MAX_RECOVERED_ROOTS) {
        const oldest = recoveredRoots.keys().next().value;
        if (oldest !== undefined) recoveredRoots.delete(oldest);
      }
    }
    return report;
  } finally {
    recoveryInFlight.delete(root);
  }
}

class TempLeaseHandle implements TempLease {
  #path: string;
  #state: "active" | "disposing" | "disposed" | "keeping" | "kept" = "active";

  constructor(
    path: string,
    readonly root: string,
    readonly recovery: ReapReport | undefined,
    private readonly identity: NonNullable<
      Awaited<ReturnType<typeof directoryIdentity>>
    >,
    private readonly ownerNamespace: string,
    private readonly generation: string,
  ) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  get disposed(): boolean {
    return this.#state === "disposed";
  }

  get kept(): boolean {
    return this.#state === "kept";
  }

  async dispose(): Promise<DisposeReceipt> {
    if (this.#state === "kept") return { path: this.#path, status: "kept" };
    if (this.#state === "disposed") {
      return { path: this.#path, status: "already-absent" };
    }
    if (this.#state !== "active") {
      throw new TempLeaseStateError(
        "A keep or dispose operation is already running",
      );
    }
    this.#state = "disposing";
    try {
      const current = await directoryIdentity(this.#path);
      if (current === undefined) {
        this.#state = "disposed";
        return { path: this.#path, status: "already-absent" };
      }
      if (!sameIdentity(this.identity, current)) {
        this.#state = "active";
        return { path: this.#path, status: "identity-changed" };
      }

      const claimed = join(
        this.root,
        reapingName(process.pid, this.ownerNamespace, this.generation),
      );
      try {
        await rename(this.#path, claimed);
      } catch (error) {
        if (isMissing(error)) {
          this.#state = "disposed";
          return { path: this.#path, status: "already-absent" };
        }
        throw error;
      }
      const claimedIdentity = await directoryIdentity(claimed);
      if (
        claimedIdentity === undefined ||
        !sameIdentity(this.identity, claimedIdentity)
      ) {
        if (claimedIdentity === undefined) {
          this.#state = "disposed";
          return { path: this.#path, status: "already-absent" };
        }
        const preservedPath = join(dirname(this.root), keptName());
        await rename(claimed, preservedPath);
        this.#state = "active";
        return {
          path: this.#path,
          status: "identity-changed",
          preservedPath,
        };
      }
      try {
        await rm(claimed, { recursive: true, force: true });
      } catch (error) {
        try {
          await rename(claimed, this.#path);
        } catch {
          this.#path = claimed;
        }
        throw error;
      }
      this.#state = "disposed";
      return { path: this.#path, status: "removed" };
    } catch (error) {
      this.#state = "active";
      throw error;
    }
  }

  async keep(): Promise<KeepReceipt> {
    if (this.#state === "kept") {
      return {
        previousPath: this.#path,
        path: this.#path,
        status: "already-kept",
      };
    }
    if (this.#state === "disposed") {
      throw new TempLeaseStateError("A disposed workspace cannot be kept");
    }
    if (this.#state !== "active") {
      throw new TempLeaseStateError(
        "A keep or dispose operation is already running",
      );
    }
    this.#state = "keeping";
    const previousPath = this.#path;
    try {
      const current = await directoryIdentity(previousPath);
      if (current === undefined || !sameIdentity(this.identity, current)) {
        throw new TempLeaseStateError(
          "The workspace disappeared or its filesystem identity changed",
        );
      }
      const destination = join(dirname(this.root), keptName());
      await rename(previousPath, destination);
      this.#path = destination;
      this.#state = "kept";
      return { previousPath, path: destination, status: "kept" };
    } catch (error) {
      this.#state = "active";
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

/** Create a crash-recoverable temporary workspace. */
export async function tempLease(
  options: CreateTempLeaseOptions = {},
): Promise<TempLease> {
  assertNotAborted(options.signal);
  const root = await ensureTempLeaseRoot(options);
  const recovery = await recoverOnce(options, root);
  assertNotAborted(options.signal);
  const namespace = await processNamespace();
  const generation = generationToken();
  const path = join(root, leaseName(process.pid, namespace, generation));
  await mkdir(path, { mode: 0o700 });
  const identity = await directoryIdentity(path);
  if (!identity) {
    await rm(path, { recursive: true, force: true });
    throw new TempLeaseStateError("Unable to capture the workspace identity");
  }
  return new TempLeaseHandle(
    path,
    root,
    recovery,
    identity,
    namespace,
    generation,
  );
}

/** Alias for callers that prefer a descriptive factory name. */
export const createTempLease = tempLease;
