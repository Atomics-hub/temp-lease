import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";

export type OwnerState = "alive" | "dead" | "unknown";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function processNamespace(): Promise<string> {
  if (process.platform !== "linux") return "host";
  try {
    const link = await readlink("/proc/self/ns/pid");
    return shortHash(link);
  } catch {
    return "unknown";
  }
}

export function ownerState(pid: number): OwnerState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
}
