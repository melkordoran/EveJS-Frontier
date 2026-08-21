"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");
const {
  cloneSqliteDatabase,
} = require("./helpers/isolatedGameStore");

test("isolated game-store backup includes live WAL frames", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-sqlite-backup-"));

  const sourcePath = path.join(root, "live.sqlite");
  const destinationPath = path.join(root, "snapshot.sqlite");
  const source = new Database(sourcePath);
  t.after(() => {
    if (source.open) {
      source.close();
    }
    fs.rmSync(root, { force: true, recursive: true });
  });
  source.pragma("journal_mode = WAL");
  source.pragma("wal_autocheckpoint = 0");
  source.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT)");
  source.prepare("INSERT INTO rows (value) VALUES (?)").run("in-live-wal");

  await cloneSqliteDatabase(sourcePath, destinationPath);

  const snapshot = new Database(destinationPath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    assert.deepEqual(snapshot.prepare("SELECT id, value FROM rows").all(), [
      { id: 1, value: "in-live-wal" },
    ]);
    assert.equal(snapshot.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    snapshot.close();
  }
});

test("SQLite backup refuses to overwrite a destination", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-sqlite-backup-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourcePath = path.join(root, "source.sqlite");
  const destinationPath = path.join(root, "existing.sqlite");
  new Database(sourcePath).close();
  fs.writeFileSync(destinationPath, "do not replace");

  await assert.rejects(
    cloneSqliteDatabase(sourcePath, destinationPath),
    /Refusing to replace an existing SQLite backup/,
  );
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "do not replace");
});
