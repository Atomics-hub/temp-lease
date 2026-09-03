import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getTempLeaseRoot,
  reapTempLeases,
  tempLease,
  TempLeaseRootError,
  TempLeaseStateError,
} from "../../src/index.js";
import { reapTempLeasesWithRuntime } from "../../src/reap.js";
import { removeIncrementally } from "../../src/remove.js";
import { ownerState } from "../../src/platform.js";

const cleanup = new Set<string>();
let cachedDeadPid: Promise<number> | undefined;

afterEach(async () => {
  await Promise.all(
    [...cleanup].map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanup.clear();
});

async function base(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "temp-lease-test-"));
  cleanup.add(path);
  return path;
}

function uniqueNamespace(label = "test"): string {
  return `${label}-${process.pid}-${Math.random()}`;
}

function parseLeaseName(path: string): {
  ownerPid: number;
  namespace: string;
  generation: string;
} {
  const match =
    /^lease-v1-p(\d+)-n([a-f0-9]{16}|host|unknown)-g([a-f0-9]{32})$/.exec(
      basename(path),
    );
  assert.ok(match, `expected owned lease name, received ${path}`);
  return {
    ownerPid: Number(match[1]),
    namespace: match[2]!,
    generation: match[3]!,
  };
}

async function waitForLine(child: ChildProcess): Promise<string> {
  assert.ok(child.stdout);
  return new Promise((resolve, reject) => {
    let buffered = "";
    child.once("error", reject);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolve(buffered.slice(0, newline));
    });
    child.once("exit", (code) => {
      if (!buffered.includes("\n")) {
        reject(new Error(`fixture exited before writing a line (${code})`));
      }
    });
  });
}

function spawnLeaseChild(
  baseDirectory: string,
  namespace: string,
  mode = "wait",
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../fixtures/lease-child.ts", import.meta.url)),
      baseDirectory,
      namespace,
      mode,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function deadWorkspace(
  baseDirectory: string,
  namespace: string,
  suffix = "0".repeat(32),
): Promise<string> {
  const probe = await tempLease({ baseDirectory, namespace, reap: false });
  const parsed = parseLeaseName(probe.path);
  await probe.dispose();
  cachedDeadPid ??= new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error("failed to allocate a child PID"));
      return;
    }
    child.once("error", reject);
    child.once("exit", () => resolve(pid));
  });
  const deadPid = await cachedDeadPid;
  const path = join(
    probe.root,
    `lease-v1-p${deadPid}-n${parsed.namespace}-g${suffix}`,
  );
  await mkdir(path);
  return path;
}

describe("tempLease", () => {
  it("creates unique private workspaces inside a deterministic namespace root", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace();
    const first = await tempLease({ baseDirectory, namespace, reap: false });
    const second = await tempLease({ baseDirectory, namespace, reap: false });

    assert.equal(first.root, getTempLeaseRoot({ baseDirectory, namespace }));
    assert.equal(second.root, first.root);
    assert.notEqual(second.path, first.path);
    assert.equal((await lstat(first.path)).isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal((await lstat(first.root)).mode & 0o777, 0o700);
    }
    assert.equal(parseLeaseName(first.path).ownerPid, process.pid);
  });

  it("disposes idempotently through an atomic claim", async () => {
    const lease = await tempLease({
      baseDirectory: await base(),
      namespace: uniqueNamespace(),
      reap: false,
    });
    await writeFile(join(lease.path, "artifact"), "data");
    assert.deepEqual(await lease.dispose(), {
      path: lease.path,
      status: "removed",
    });
    assert.equal(lease.disposed, true);
    assert.deepEqual(await lease.dispose(), {
      path: lease.path,
      status: "already-absent",
    });
  });

  it("preserves a same-name replacement detected by its identity receipt", async () => {
    const lease = await tempLease({
      baseDirectory: await base(),
      namespace: uniqueNamespace(),
      reap: false,
    });
    await rm(lease.path, { recursive: true });
    await mkdir(lease.path);
    await writeFile(join(lease.path, "replacement"), "keep");

    const receipt = await lease.dispose();
    assert.equal(receipt.status, "identity-changed");
    assert.equal(
      await readFile(join(lease.path, "replacement"), "utf8"),
      "keep",
    );
    assert.equal(lease.disposed, false);
  });

  it("keeps a workspace under an unowned name and returns the new path", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("keep");
    const lease = await tempLease({
      baseDirectory,
      namespace,
      reap: false,
    });
    const original = lease.path;
    await writeFile(join(original, "artifact"), "keep");
    const kept = await lease.keep();

    assert.equal(kept.previousPath, original);
    assert.match(kept.path, /kept-v1-g[a-f0-9]{32}$/);
    assert.notEqual(dirname(kept.path), lease.root);
    assert.equal(lease.path, kept.path);
    assert.equal(lease.kept, true);
    assert.equal(await readFile(join(kept.path, "artifact"), "utf8"), "keep");
    assert.equal((await lease.dispose()).status, "kept");
    assert.equal((await lease.keep()).status, "already-kept");
    const report = await reapTempLeases({ baseDirectory, namespace });
    assert.equal(report.scanned, 0);
  });

  it("refuses to keep a disposed workspace", async () => {
    const lease = await tempLease({
      baseDirectory: await base(),
      namespace: uniqueNamespace(),
      reap: false,
    });
    await lease.dispose();
    await assert.rejects(lease.keep(), TempLeaseStateError);
  });

  it("supports explicit async disposal", async () => {
    const lease = await tempLease({
      baseDirectory: await base(),
      namespace: uniqueNamespace(),
      reap: false,
    });
    await lease[Symbol.asyncDispose]();
    assert.equal(lease.disposed, true);
  });

  it("runs bounded recovery automatically before the first creation", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("automatic");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    const lease = await tempLease({ baseDirectory, namespace });

    assert.equal(lease.recovery?.reaped.length, 1);
    assert.equal(lease.recovery?.reaped[0]?.name, basename(orphan));
    await assert.rejects(lstat(orphan), { code: "ENOENT" });
    const second = await tempLease({ baseDirectory, namespace });
    assert.equal(second.recovery, undefined);
    await lease.dispose();
    await second.dispose();
  });

  it("continues incomplete automatic recovery instead of caching it", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("automatic-resume");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    for (let index = 0; index < 24; index += 1) {
      await writeFile(join(orphan, `artifact-${index}`), String(index));
    }

    let lease = await tempLease({
      baseDirectory,
      namespace,
      reap: { maxTreeEntries: 6, maxReaps: 1, maxDurationMs: 10_000 },
    });
    assert.equal(lease.recovery?.progressed.length, 1);
    await lease.dispose();

    let completed = false;
    for (let pass = 0; pass < 10 && !completed; pass += 1) {
      lease = await tempLease({
        baseDirectory,
        namespace,
        reap: { maxTreeEntries: 6, maxReaps: 1, maxDurationMs: 10_000 },
      });
      completed = (lease.recovery?.reaped.length ?? 0) === 1;
      await lease.dispose();
    }

    assert.equal(completed, true);
    await assert.rejects(lstat(orphan), { code: "ENOENT" });
  });

  it("rejects invalid namespaces and pre-aborted creation", async () => {
    const baseDirectory = await base();
    await assert.rejects(
      tempLease({ baseDirectory, namespace: "", reap: false }),
      TypeError,
    );
    await assert.rejects(
      tempLease({ baseDirectory, namespace: "x".repeat(129), reap: false }),
      TypeError,
    );
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    await assert.rejects(
      tempLease({
        baseDirectory,
        namespace: uniqueNamespace(),
        signal: controller.signal,
      }),
      reason,
    );
    const reasonlessSignal = {
      aborted: true,
      reason: undefined,
    } as AbortSignal;
    await assert.rejects(
      tempLease({
        baseDirectory,
        namespace: uniqueNamespace(),
        signal: reasonlessSignal,
      }),
      { name: "AbortError" },
    );
  });

  it("rejects a symlink substituted for its private root", async () => {
    if (process.platform === "win32") return;
    const baseDirectory = await base();
    const namespace = uniqueNamespace();
    const root = getTempLeaseRoot({ baseDirectory, namespace });
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    const target = await mkdtemp(join(tmpdir(), "temp-lease-target-"));
    cleanup.add(target);
    await symlink(target, root);
    await assert.rejects(
      tempLease({ baseDirectory, namespace, reap: false }),
      TempLeaseRootError,
    );
  });

  it("rejects roots made accessible to another Unix user", async () => {
    if (process.platform === "win32") return;
    const baseDirectory = await base();
    const namespace = uniqueNamespace();
    const first = await tempLease({ baseDirectory, namespace, reap: false });
    await chmod(first.root, 0o755);
    await assert.rejects(
      tempLease({ baseDirectory, namespace, reap: false }),
      TempLeaseRootError,
    );
  });
});

describe("reapTempLeases", () => {
  it("recognizes the current process as a live owner", () => {
    assert.equal(ownerState(process.pid), "alive");
  });

  it("reaps a workspace after its owner is killed", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("sigkill");
    const child = spawnLeaseChild(baseDirectory, namespace);
    const created = JSON.parse(await waitForLine(child)) as {
      path: string;
      pid: number;
    };
    await stop(child);

    const report = await reapTempLeases({ baseDirectory, namespace });
    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0]?.name, basename(created.path));
    assert.equal(report.reaped[0]?.kind, "lease");
    await assert.rejects(lstat(created.path), { code: "ENOENT" });
  });

  it("refuses a live owner", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("live");
    const lease = await tempLease({ baseDirectory, namespace, reap: false });
    const report = await reapTempLeases({ baseDirectory, namespace });
    assert.deepEqual(report.reaped, []);
    assert.deepEqual(report.skipped, [
      { name: basename(lease.path), reason: "live-owner" },
    ]);
    assert.equal((await lstat(lease.path)).isDirectory(), true);
  });

  it("lets only one of many concurrent reapers claim an orphan", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("concurrent");
    const path = await deadWorkspace(baseDirectory, namespace);
    const reports = await Promise.all(
      Array.from({ length: 16 }, () =>
        reapTempLeases({ baseDirectory, namespace }),
      ),
    );
    const reaped = reports.flatMap((report) => report.reaped);
    assert.equal(reaped.length, 1, JSON.stringify(reaped));
    await assert.rejects(lstat(path), { code: "ENOENT" });
  });

  it("recovers an abandoned atomic claim after that reaper dies", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("reaper-crash");
    const child = spawnLeaseChild(baseDirectory, namespace);
    const created = JSON.parse(await waitForLine(child)) as {
      path: string;
      pid: number;
    };
    const parsed = parseLeaseName(created.path);
    await stop(child);
    const abandonedName = `.reaping-v1-p${created.pid}-n${parsed.namespace}-o${created.pid}-g${parsed.generation}-c${"a".repeat(32)}`;
    const abandoned = join(dirname(created.path), abandonedName);
    await rename(created.path, abandoned);

    const report = await reapTempLeases({ baseDirectory, namespace });
    assert.equal(report.reaped[0]?.kind, "abandoned-reap");
    assert.equal(report.reaped[0]?.name, abandonedName);
    await assert.rejects(lstat(abandoned), { code: "ENOENT" });
  });

  it("never follows a symlink inside an orphan", async () => {
    if (process.platform === "win32") return;
    const baseDirectory = await base();
    const namespace = uniqueNamespace("symlink");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    const external = await mkdtemp(join(tmpdir(), "temp-lease-external-"));
    cleanup.add(external);
    const target = join(external, "survive");
    await writeFile(target, "outside");
    await symlink(target, join(orphan, "link"));

    const report = await reapTempLeases({ baseDirectory, namespace });
    assert.equal(report.reaped.length, 1);
    assert.equal(await readFile(target, "utf8"), "outside");
  });

  it("reports and preserves malformed, foreign, non-directory, and foreign-namespace entries", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("refuse");
    const lease = await tempLease({ baseDirectory, namespace, reap: false });
    const parsed = parseLeaseName(lease.path);
    await lease.dispose();
    await mkdir(join(lease.root, "unrelated"));
    const dead = parseLeaseName(
      await deadWorkspace(baseDirectory, namespace, "f".repeat(32)),
    ).ownerPid;
    const seeded = join(
      lease.root,
      `lease-v1-p${dead}-n${parsed.namespace}-g${"f".repeat(32)}`,
    );
    await rm(seeded, { recursive: true, force: true });
    const notDirectory = `lease-v1-p${dead}-n${parsed.namespace}-g${"b".repeat(32)}`;
    await writeFile(join(lease.root, notDirectory), "not a directory");
    const mismatch = `lease-v1-p${dead}-n${"c".repeat(16)}-g${"d".repeat(32)}`;
    await mkdir(join(lease.root, mismatch));
    const unknown = `lease-v1-p${dead}-nunknown-g${"e".repeat(32)}`;
    await mkdir(join(lease.root, unknown));

    const report = await reapTempLeases({ baseDirectory, namespace });
    const reasons = new Map(
      report.skipped.map((item) => [item.name, item.reason]),
    );
    assert.equal(reasons.get("unrelated"), "foreign");
    assert.equal(reasons.get(notDirectory), "not-directory");
    assert.equal(reasons.get(mismatch), "namespace-mismatch");
    assert.equal(reasons.get(unknown), "namespace-unknown");
    assert.equal(report.reaped.length, 0);
  });

  it("honors byte, tree-entry, reap-count, root-entry, time, and abort budgets", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("budgets");
    const first = await deadWorkspace(baseDirectory, namespace, "1".repeat(32));
    await writeFile(join(first, "payload"), "x".repeat(100));
    const byteReport = await reapTempLeases({
      baseDirectory,
      namespace,
      maxBytes: 1,
      maxReaps: 1,
    });
    assert.equal(byteReport.progressed[0]?.reason, "byte-budget");
    assert.equal(byteReport.truncated, true);

    const treeReport = await reapTempLeases({
      baseDirectory,
      namespace,
      maxTreeEntries: 1,
      maxReaps: 1,
    });
    assert.equal(treeReport.progressed[0]?.reason, "entry-budget");
    assert.equal(treeReport.truncated, true);

    const second = await deadWorkspace(
      baseDirectory,
      namespace,
      "2".repeat(32),
    );
    const reapReport = await reapTempLeases({
      baseDirectory,
      namespace,
      maxReaps: 1,
      maxBytes: 1024 ** 2,
    });
    assert.equal(reapReport.reaped.length, 1);
    assert.equal(reapReport.truncated, true);

    const entryReport = await reapTempLeases({
      baseDirectory,
      namespace,
      maxEntries: 0,
    });
    assert.equal(entryReport.scanned, 0);
    assert.equal(entryReport.truncated, true);

    const timeReport = await reapTempLeases({
      baseDirectory,
      namespace,
      maxDurationMs: 0,
    });
    assert.equal(timeReport.truncated, true);

    const controller = new AbortController();
    controller.abort();
    const abortReport = await reapTempLeases({
      baseDirectory,
      namespace,
      signal: controller.signal,
    });
    assert.equal(abortReport.truncated, true);
    assert.equal(abortReport.skipped[0]?.reason, "aborted");

    assert.equal((await readdir(dirname(first))).length > 0, true);
    void second;
  });

  it("reclaims a large tree over bounded resumable chunks", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("chunks");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    for (let index = 0; index < 31; index += 1) {
      await writeFile(join(orphan, `artifact-${index}`), "payload");
    }

    const first = await reapTempLeases({
      baseDirectory,
      namespace,
      maxTreeEntries: 7,
      maxReaps: 1,
      maxDurationMs: 10_000,
    });
    assert.equal(first.progressed.length, 1);
    assert.equal(first.progressed[0]?.reason, "entry-budget");
    assert.match(first.progressed[0]?.queuedName ?? "", /^\.queued-v1-/);

    let finalKind: string | undefined;
    for (let pass = 0; pass < 10 && finalKind === undefined; pass += 1) {
      const report = await reapTempLeases({
        baseDirectory,
        namespace,
        maxTreeEntries: 7,
        maxReaps: 1,
        maxDurationMs: 10_000,
      });
      finalKind = report.reaped[0]?.kind;
    }

    assert.equal(finalKind, "continued-reap");
    const protocolEntries = (await readdir(dirname(orphan))).filter((name) =>
      /^(?:lease-v1|\.reaping-v1|\.queued-v1)-/.test(name),
    );
    assert.deepEqual(protocolEntries, []);
  });

  it("finishes a claimed chunk after the pass deadline to guarantee progress", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("deadline-progress");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    await writeFile(join(orphan, "payload"), "data");
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const report = await reapTempLeasesWithRuntime(
        { baseDirectory, namespace, maxDurationMs: 10 },
        {
          rename,
          async removeIncrementally(path, options) {
            now = 11;
            return removeIncrementally(path, options);
          },
        },
      );
      assert.equal(report.reaped.length, 1);
      assert.equal(report.progressed.length, 0);
      await assert.rejects(lstat(orphan), { code: "ENOENT" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("rolls a claim back when queueing an incomplete chunk fails", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("queue-rollback");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    let renameCalls = 0;

    const report = await reapTempLeasesWithRuntime(
      { baseDirectory, namespace, maxRetries: 0 },
      {
        async rename(source, destination) {
          renameCalls += 1;
          if (renameCalls === 2) {
            throw Object.assign(new Error("queue unavailable"), {
              code: "EACCES",
            });
          }
          await rename(source, destination);
        },
        async removeIncrementally() {
          return {
            complete: false,
            removedRoot: false,
            reason: "entry-budget",
            removedBytes: 0,
            visitedEntries: 1,
          };
        },
      },
    );

    assert.equal(renameCalls, 3);
    assert.equal(report.truncated, true);
    assert.equal(report.progressed.length, 0);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.operation, "queue");
    assert.equal((await lstat(orphan)).isDirectory(), true);
    assert.equal(
      (await readdir(dirname(orphan))).some((name) =>
        name.startsWith(".reaping-v1-"),
      ),
      false,
    );
  });

  it("reports a vanished claimed root as a lost race", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("vanished-claim");
    const orphan = await deadWorkspace(baseDirectory, namespace);

    const report = await reapTempLeasesWithRuntime(
      { baseDirectory, namespace },
      {
        rename,
        async removeIncrementally(path) {
          await rm(path, { recursive: true, force: true });
          return {
            complete: true,
            removedRoot: false,
            removedBytes: 0,
            visitedEntries: 0,
          };
        },
      },
    );

    assert.deepEqual(report.reaped, []);
    assert.deepEqual(report.skipped, [
      { name: basename(orphan), reason: "race-lost" },
    ]);
  });

  it("removes a sparse workspace larger than the former default byte ceiling", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace("large-sparse");
    const orphan = await deadWorkspace(baseDirectory, namespace);
    const sparseFile = join(orphan, "large-sparse-file");
    await writeFile(sparseFile, "");
    await truncate(sparseFile, 11 * 1024 ** 3);

    const report = await reapTempLeases({
      baseDirectory,
      namespace,
      maxDurationMs: 10_000,
    });
    assert.equal(report.reaped.length, 1);
    assert.equal(report.errors.length, 0);
    await assert.rejects(lstat(orphan), { code: "ENOENT" });
  });

  it("validates all budget values", async () => {
    const baseDirectory = await base();
    const namespace = uniqueNamespace();
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        reapTempLeases({ baseDirectory, namespace, maxEntries: value }),
        RangeError,
      );
    }
    await assert.rejects(
      reapTempLeases({ baseDirectory, namespace, maxConcurrency: 0 }),
      RangeError,
    );
    await assert.rejects(
      reapTempLeases({ baseDirectory, namespace, maxRetries: -1 }),
      RangeError,
    );
    await assert.rejects(
      reapTempLeases({ baseDirectory, namespace, retryDelayMs: 0.5 }),
      RangeError,
    );
  });
});
