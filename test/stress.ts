import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { generationToken } from "../src/names.js";
import { reapTempLeases, tempLease } from "../src/index.js";

const baseDirectory = await mkdtemp(join(tmpdir(), "temp-lease-stress-"));
const namespace = `stress-${process.pid}-${Date.now()}`;

try {
  for (let index = 0; index < 1_000; index += 1) {
    const lease = await tempLease({ baseDirectory, namespace, reap: false });
    await writeFile(join(lease.path, "artifact"), String(index));
    assert.equal((await lease.dispose()).status, "removed");
  }

  const probe = await tempLease({ baseDirectory, namespace, reap: false });
  const match = /-n([a-f0-9]{16}|host|unknown)-g/.exec(basename(probe.path));
  assert.ok(match);
  const processNamespace = match[1]!;
  const root = probe.root;
  await probe.dispose();
  const deadPid = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error("failed to allocate a child PID"));
      return;
    }
    child.once("error", reject);
    child.once("exit", () => resolve(pid));
  });

  for (let index = 0; index < 500; index += 1) {
    const path = join(
      root,
      `lease-v1-p${deadPid}-n${processNamespace}-g${generationToken()}`,
    );
    await mkdir(path);
    await writeFile(join(path, "artifact"), "x".repeat(index % 101));
  }

  const reports = await Promise.all(
    Array.from({ length: 32 }, () =>
      reapTempLeases({
        baseDirectory,
        namespace,
        maxEntries: 10_000,
        maxReaps: 1_000,
        maxBytes: 1024 ** 3,
        maxTreeEntries: 10_000,
        maxDurationMs: 30_000,
      }),
    ),
  );
  const removed = reports.reduce(
    (sum, report) => sum + report.reaped.length,
    0,
  );
  const errors = reports.flatMap((report) => report.errors);
  const leftovers = (await readdir(root)).filter((name) =>
    /^(?:lease-v1|\.reaping-v1)-/.test(name),
  );

  assert.equal(removed, 500);
  assert.deepEqual(errors, []);
  assert.deepEqual(leftovers, []);
  console.log(
    "Stress passed: 1,000 create/dispose cycles; 500 orphans; 32 concurrent reapers; zero leaks",
  );
} finally {
  await rm(baseDirectory, { recursive: true, force: true });
}
