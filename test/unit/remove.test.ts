import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryOperation } from "../../src/remove.js";

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("filesystem retries", () => {
  it("retries transient failures with a bounded attempt count", async () => {
    let attempts = 0;
    const result = await retryOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw codedError("EPERM");
        return "removed";
      },
      2,
      0,
    );
    assert.equal(result, "removed");
    assert.equal(attempts, 3);
  });

  it("stops after the configured retry limit", async () => {
    let attempts = 0;
    await assert.rejects(
      retryOperation(
        async () => {
          attempts += 1;
          throw codedError("EBUSY");
        },
        2,
        0,
      ),
      { code: "EBUSY" },
    );
    assert.equal(attempts, 3);
  });

  it("does not retry permanent failures", async () => {
    let attempts = 0;
    await assert.rejects(
      retryOperation(
        async () => {
          attempts += 1;
          throw codedError("EINVAL");
        },
        5,
        0,
      ),
      { code: "EINVAL" },
    );
    assert.equal(attempts, 1);
  });
});
