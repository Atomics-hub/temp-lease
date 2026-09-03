import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
  generationToken,
  leaseName,
  parseOwnedName,
  reapingName,
} from "../../src/names.js";

describe("owned names", () => {
  it("round-trips valid lease names", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_147_483_647 }),
        fc.constantFrom("host", "unknown", "0123456789abcdef"),
        (pid, namespace) => {
          const generation = generationToken();
          assert.deepEqual(
            parseOwnedName(leaseName(pid, namespace, generation)),
            {
              kind: "lease",
              ownerPid: pid,
              namespace,
              generation,
            },
          );
        },
      ),
    );
  });

  it("round-trips valid reaping names", () => {
    const generation = generationToken();
    const parsed = parseOwnedName(reapingName(42, "host", generation));
    assert.deepEqual(parsed, {
      kind: "reaping",
      reaperPid: process.pid,
      ownerPid: 42,
      namespace: "host",
      generation,
    });
  });

  it("rejects arbitrary and nearly-valid names", () => {
    const invalid = [
      "",
      ".",
      "lease-v1-p0-nhost-g" + "a".repeat(32),
      "lease-v1-p1-nhost-g../outside",
      "lease-v1-p1-nHOST-g" + "a".repeat(32),
      "lease-v2-p1-nhost-g" + "a".repeat(32),
      ".reaping-v1-p1-nhost-o0-g" + "a".repeat(32) + "-c" + "b".repeat(32),
      "kept-v1-g" + "a".repeat(32),
    ];
    for (const name of invalid) assert.equal(parseOwnedName(name), undefined);
  });

  it("never recognizes unconstrained fuzz strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        const parsed = parseOwnedName(value);
        if (parsed) {
          assert.match(value, /^(?:lease-v1|\.reaping-v1)-/);
          assert.equal(value.includes("/"), false);
          assert.equal(value.includes("\\"), false);
        }
      }),
      { numRuns: 10_000 },
    );
  });
});
