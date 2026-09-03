import { lstat } from "node:fs/promises";

export interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export async function directoryIdentity(
  path: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    return {
      dev: stats.dev,
      ino: stats.ino,
      birthtimeNs: stats.birthtimeNs,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function sameIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}
