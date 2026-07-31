import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseResourceIndex,
  resolveIndexedResource,
} from "../lib/resource-index.mjs";

test("parseResourceIndex reads a Frontier index row", () => {
  const entries = parseResourceIndex(
    "res:/staticdata/types.fsdbinary,3c/aabb_ccdd,source_hash,100,4\n",
  );
  assert.deepEqual(entries.get("res:/staticdata/types.fsdbinary"), {
    cachePath: "3c/aabb_ccdd",
    logicalPath: "res:/staticdata/types.fsdbinary",
    packedSize: 4,
    sourceHash: "source_hash",
    unpackedSize: 100,
  });
});

test("parseResourceIndex rejects malformed and duplicate rows", () => {
  assert.throws(
    () => parseResourceIndex("res:/one,aa/cache,hash,1\n"),
    /expected 5 fields/,
  );
  assert.throws(
    () => parseResourceIndex(
      "res:/one,aa/aabb,hash,1,1\nres:/one,bb/ccdd,hash,1,1\n",
    ),
    /Duplicate resource index entry/,
  );
  assert.throws(
    () => parseResourceIndex("res:/one,../escape,hash,1,1\n"),
    /invalid cache path/,
  );
});

test("resolveIndexedResource verifies the physical cache file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-index-"));
  try {
    fs.mkdirSync(path.join(root, "aa"));
    fs.writeFileSync(path.join(root, "aa", "aabb"), "data");
    const entries = parseResourceIndex("res:/one,aa/aabb,hash,4,2\n");
    const resolved = resolveIndexedResource(entries, "res:/one", root);
    assert.equal(resolved.physicalPath, path.join(root, "aa", "aabb"));
    assert.equal(resolved.unpackedSize, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
