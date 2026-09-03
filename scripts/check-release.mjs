import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(packageJson.name, "temp-lease");
assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(packageJson.private, undefined);
assert.equal(packageJson.sideEffects, false);
assert.equal(packageJson.publishConfig?.access, "public");
assert.equal(packageJson.publishConfig?.provenance, true);
assert.equal(packageJson.dependencies, undefined);
assert.equal(packageJson.scripts?.prepublishOnly, "npm run verify");
assert.ok(packageJson.files.includes("dist"));
assert.ok(packageJson.files.includes("AUDIT.md"));
assert.ok(packageJson.exports?.["."]?.import?.types);
assert.ok(packageJson.exports?.["."]?.require?.types);
console.log(
  `Release metadata passed for ${packageJson.name}@${packageJson.version}`,
);
