# EVE Frontier Static Data

This tool exports the static data embedded in an installed EVE Frontier client
into the JSONL shape consumed by EveJS. It reads the copied client cache only.
It does not modify the Frontier installation, the retail EVE client, or an
EveJS server database.

The extractor:

- selects an installed Frontier build from `start.ini`;
- resolves every packaged resource through that build's `resfileindex.txt`;
- checks each resolved cache file before reading it;
- uses the client's bundled Python 3.12 runtime and native FSD loaders;
- reads `mapObjects.db` in SQLite read-only mode;
- writes deterministic, build-numbered JSONL under `_local/frontier-sde`;
- records source and output hashes in `frontier-extraction-manifest.json`.

## Extract

```bash
npm run frontier:extract -- --build 3450341
```

The default client root is:

```text
~/Library/Application Support/EVE Frontier
```

To inspect inputs without decoding:

```bash
npm run frontier:extract -- --build 3450341 --dry-run
```

To replace a snapshot previously created by this extractor:

```bash
npm run frontier:extract -- --build 3450341 --force
```

The tool refuses to replace a non-empty directory unless it contains a
recognized extractor manifest.

## Validate

```bash
npm run frontier:validate -- --snapshot _local/frontier-sde/3450341
```

Validation checks hashes, JSONL framing, key uniqueness, type/group/category
references, system/star relationships, map-object system references, and
reciprocal stargate destinations.

## EveJS Input

The generated folder is intentionally compatible with:

```bash
node tools/DatabaseCreator/database-creator.js \
  --sde-dir _local/frontier-sde/3450341 \
  --out _local/frontier-gameStore/data \
  --build 3450341
```

Frontier-specific map data that the current EveJS generator does not yet
consume is retained in `mapLagrangePoints.jsonl`, `mapJumps.jsonl`, and
`locationCache.jsonl` for the compatibility layer.
