import { tempLease } from "../../src/index.js";

const baseDirectory = process.argv[2];
const namespace = process.argv[3];
const mode = process.argv[4] ?? "wait";

if (!baseDirectory || !namespace) throw new Error("missing fixture arguments");

const lease = await tempLease({ baseDirectory, namespace, reap: false });
process.stdout.write(
  `${JSON.stringify({ path: lease.path, pid: process.pid })}\n`,
);

if (mode === "wait") {
  setInterval(() => undefined, 60_000);
}
