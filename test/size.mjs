import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const limits = { "dist/index.js": 7_000, "dist/index.cjs": 7_500 };
for (const [file, limit] of Object.entries(limits)) {
  const source = await readFile(file);
  const gzip = gzipSync(source, { level: 9 });
  if (gzip.byteLength > limit) {
    throw new Error(
      `${file} is ${gzip.byteLength} bytes gzip; budget is ${limit}`,
    );
  }
  console.log(
    `${file}: ${source.byteLength} bytes raw, ${gzip.byteLength} bytes gzip`,
  );
}
