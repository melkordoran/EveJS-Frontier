import assert from "node:assert/strict";
import test from "node:test";

import { parseStartIni } from "../lib/start-ini.mjs";

test("parseStartIni reads Frontier build metadata", () => {
  const values = parseStartIni(`
    ; comment
    [main]
    version = 20.04
    build = 3450341
    branch = //frontier/cycle-6
    appname = FRONTIER
  `);
  assert.deepEqual(values, {
    "main.appname": "FRONTIER",
    "main.branch": "//frontier/cycle-6",
    "main.build": "3450341",
    "main.version": "20.04",
  });
});
