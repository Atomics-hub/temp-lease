import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tempLease } from "../dist/index.js";

const baseDirectory = await mkdtemp(join(tmpdir(), "temp-lease-runtime-"));

try {
  const lease = await tempLease({
    baseDirectory,
    namespace: `node-${process.versions.node}`,
    reap: false,
  });
  await writeFile(join(lease.path, "artifact"), "ok");
  assert.equal((await lstat(lease.path)).isDirectory(), true);
  assert.equal((await lease.dispose()).status, "removed");

  const require = createRequire(import.meta.url);
  const commonjs = require("../dist/index.cjs");
  assert.equal(typeof commonjs.tempLease, "function");
  console.log(`Node ${process.versions.node}: ESM and CommonJS smoke passed`);
} finally {
  await rm(baseDirectory, { recursive: true, force: true });
}
