import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(await readFile(new URL("../assets/material-symbols/asset-manifest.json", import.meta.url)));

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

for (const asset of manifest.assets) {
  const bytes = await readFile(new URL(`../${asset.path}`, import.meta.url));
  assert.equal(digest(bytes), asset.sha256, `${asset.path} does not match its pinned SHA-256`);

  const scratch = await mkdtemp(join(tmpdir(), "whiteboard-asset-check-"));
  try {
    const mutated = Buffer.from(bytes);
    mutated[0] ^= 1;
    const copy = join(scratch, "mutated-copy");
    await writeFile(copy, mutated);
    assert.notEqual(digest(await readFile(copy)), asset.sha256, `mutation was not rejected for ${asset.path}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

console.log(`verified ${manifest.assets.length} pinned files and rejected one-byte mutations`);
