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
- flattens Frontier landscape sites into warpable per-system metadata;
- preserves referenced ecosystem rules and complete dungeon room/object layouts
  in `landscapeEcosystems.jsonl` and `landscapeDungeonTemplates.jsonl`;
- exports every authored dungeon to `frontierDungeonTemplates.jsonl`, including
  Crude Rift entry objects, resources, transforms, triggers, and events;
- preserves modular ship templates, parts, modules, and hardpoint definitions
  used by the Frontier Creation management service;
- writes deterministic, build-numbered JSONL under `_local/frontier-sde`;
- records source and output hashes in `frontier-extraction-manifest.json`.

## Extract

```bash
npm run frontier:extract -- --build 3465410
```

The default client root is:

```text
~/Library/Application Support/EVE Frontier
```

To inspect inputs without decoding:

```bash
npm run frontier:extract -- --build 3465410 --dry-run
```

To replace a snapshot previously created by this extractor:

```bash
npm run frontier:extract -- --build 3465410 --force
```

The tool refuses to replace a non-empty directory unless it contains a
recognized extractor manifest.

## Validate

```bash
npm run frontier:validate -- --snapshot _local/frontier-sde/3465410
```

Validation checks hashes, JSONL framing, key uniqueness, type/group/category
references, system/star relationships, map-object system references, and
reciprocal stargate destinations.

Landscape validation also checks that every site references an exported
ecosystem and entry dungeon, every ecosystem pattern references an exported
dungeon, and every dungeon object references a known client type.

The complete dungeon table is retained separately from landscape sites. The
Rift compatibility layer uses it to materialize persistent, client-authored
Crude Rift scenes without modifying the Frontier client or guessing object
types and placement.

Creation validation checks that every modular hull template references known
parts and modules, and that its initial interior placements and hardpoints are
complete enough to reconstruct the client management model.

## Client Contracts

The copied Frontier `code.ccp` archive also carries generated public protobuf
descriptors and the client modules that consume them. Export those contracts
without importing the game runtime or modifying the client:

```bash
npm run frontier:contracts -- --build 3465410
```

The build-numbered output under `_local/frontier-contracts` contains a binary
descriptor set, a JSON descriptor set, a compact field index, and an inventory
of the Frontier landscape, character, industry, scanner, assembly, and web3
modules used for compatibility research.

## EveJS Input

The generated folder is intentionally compatible with:

```bash
node tools/DatabaseCreator/database-creator.js \
  --sde-dir _local/frontier-sde/3465410 \
  --out _local/frontier-gameStore/3465410/data \
  --build 3465410
```

Frontier-specific map data that the current EveJS generator does not yet
consume is retained in `mapLagrangePoints.jsonl`, `mapJumps.jsonl`, and
`locationCache.jsonl` for the compatibility layer. The three landscape tables
provide site anchors, procedural ecosystem selections, and exact client-authored
room objects. EveJS materializes a bounded sample of renderable objects only
when a pilot reaches a site; locator records remain available as authority for
future resource, event, and POI providers.
