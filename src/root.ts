import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { TempLeaseRootError } from "./errors.js";
import type { TempLeaseLocationOptions } from "./types.js";

const DEFAULT_NAMESPACE = "default";

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function validateNamespace(namespace: string): string {
  if (
    namespace.length === 0 ||
    namespace.length > 128 ||
    namespace.includes("\0")
  ) {
    throw new TypeError("namespace must contain between 1 and 128 characters");
  }
  return namespace;
}

function userToken(): string {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const identity = uid === undefined ? userInfo().username : String(uid);
  return hash(`${process.platform}:${identity}`, 16);
}

export function getTempLeaseRoot(
  options: TempLeaseLocationOptions = {},
): string {
  const namespace = validateNamespace(options.namespace ?? DEFAULT_NAMESPACE);
  const baseDirectory = resolve(options.baseDirectory ?? tmpdir());
  if (!isAbsolute(baseDirectory)) {
    throw new TypeError("baseDirectory must resolve to an absolute path");
  }
  return join(
    baseDirectory,
    `.temp-lease-v1-${userToken()}`,
    `ns-${hash(namespace, 32)}`,
  );
}

async function assertPrivateDirectory(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new TempLeaseRootError(
      `Unable to inspect temp-lease root: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TempLeaseRootError(
      "temp-lease root must be a real directory, not a file or symlink",
      path,
    );
  }

  if (process.platform !== "win32") {
    if ((stats.mode & 0o077) !== 0 || (stats.mode & 0o700) !== 0o700) {
      throw new TempLeaseRootError(
        "temp-lease root must have private 0700 permissions",
        path,
      );
    }
    if (
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new TempLeaseRootError(
        "temp-lease root must be owned by the current user",
        path,
      );
    }
  }
}

export async function ensureTempLeaseRoot(
  options: TempLeaseLocationOptions = {},
): Promise<string> {
  const root = getTempLeaseRoot(options);
  const packageRoot = resolve(root, "..");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(packageRoot);
  await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
  });
  await assertPrivateDirectory(root);
  return root;
}
