import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "temp-lease-package-"));

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", temporary],
    { cwd: root, encoding: "utf8" },
  );
  const packed = JSON.parse(packOutput)[0];
  assert.equal(packed.name, "temp-lease");
  assert.equal(
    packed.files.some((file) => file.path.startsWith("src/")),
    false,
  );
  assert.equal(
    packed.files.some((file) => file.path.startsWith("test/")),
    false,
  );
  for (const path of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
  ]) {
    assert.equal(
      packed.files.some((file) => file.path === path),
      true,
      `${path} must be packed`,
    );
  }
  assert.ok(packed.size < 40_000, `tarball is too large: ${packed.size}`);

  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const tarball = join(temporary, packed.filename);
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: consumer, stdio: "pipe" },
  );

  await writeFile(
    join(consumer, "esm.mjs"),
    `import { tempLease } from "temp-lease";
const lease = await tempLease({ namespace: "package-esm", reap: false });
if (!lease.path.includes("lease-v1")) throw new Error("ESM smoke failed");
await lease.dispose();`,
  );
  await writeFile(
    join(consumer, "cjs.cjs"),
    `const { tempLease } = require("temp-lease");
tempLease({ namespace: "package-cjs", reap: false }).then(async lease => {
  if (!lease.path.includes("lease-v1")) process.exitCode = 1;
  await lease.dispose();
});`,
  );
  await writeFile(
    join(consumer, "types.ts"),
    `import { tempLease, type TempLease, type ReapReport } from "temp-lease";
const lease: Promise<TempLease> = tempLease({ namespace: "types" });
lease.then(value => { const report: ReapReport | undefined = value.recovery; void report; });`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        lib: ["ES2022", "DOM", "ESNext.Disposable"],
      },
      include: ["types.ts"],
    }),
  );

  execFileSync("node", ["esm.mjs"], { cwd: consumer, stdio: "inherit" });
  execFileSync("node", ["cjs.cjs"], { cwd: consumer, stdio: "inherit" });
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: consumer, stdio: "inherit" },
  );

  const installedPackage = JSON.parse(
    await readFile(
      join(consumer, "node_modules/temp-lease/package.json"),
      "utf8",
    ),
  );
  assert.equal(installedPackage.dependencies, undefined);
  assert.deepEqual(
    (await readdir(join(consumer, "node_modules/temp-lease"))).sort(),
    [
      "AUDIT.md",
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "dist",
      "package.json",
    ],
  );
  console.log(
    `Packed consumer smoke passed: ${packed.filename} (${packed.size} bytes)`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
