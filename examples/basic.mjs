import { tempLease } from "temp-lease";

const workspace = await tempLease({ namespace: "example-downloader" });

try {
  console.log(`Use the temporary workspace at ${workspace.path}`);
} finally {
  await workspace.dispose();
}
