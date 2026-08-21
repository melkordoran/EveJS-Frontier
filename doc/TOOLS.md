# Tools And Admin Basics

This page explains the `tools/` folder in normal human language. EVE Frontier
and conventional EVE Online have separate client tools and must not share
binary patch recipes.

## Frontier Windows tools

The Windows Frontier entry points live at the repository root, while their
strict shared implementation lives under `tools\frontier-client` and
`tools\frontier-static`.

### Client discovery and extraction

```powershell
npm run frontier:discover -- --client-root 'C:\CCP\EVE Frontier\stillness'
npm run frontier:extract -- --client-root 'C:\CCP\EVE Frontier\stillness' --build 3474408
npm run frontier:validate -- --snapshot '_local\frontier-sde\3474408'
npm run frontier:contracts -- --client-root 'C:\CCP\EVE Frontier\stillness' --build 3474408
npm run frontier:database -- --snapshot '_local\frontier-sde\3474408'
```

`tools\frontier-static\lib\frontier-client-discovery.mjs` implements the
platform-neutral client rules used by discovery, extraction, contracts, and
Windows staging. `frontier-python.mjs` first probes exact external Python 3.12
on Windows, then uses the minimal `frontier-python-runner-windows.c` fallback
only if native client loaders require the embedded `python312.dll`.

The extractor and contract exporter write recognized, build-numbered outputs
under `_local` and refuse to replace unrelated directories. They read the
official client and never stage or mutate it.

### Exact stage patcher

`tools\frontier-client\frontier_windows_client.py` is the transaction and
read-only verifier behind `PatchFrontierClientTrust.ps1`. It centralizes:

- exact source/target/partial/unknown PE states;
- verified certificate-overlay removal and PE checksum recalculation;
- exact docking and selected feature bytecode profiles;
- CA idempotency and leaf-chain verification;
- strict manifest version, entry, digest, path, and trailer checks;
- marker containment, `ResFiles`, backup, rollback, and official hash checks.

Build `3474408` uses
`tools\frontier-client\blue-pyd.3474408.patch.json`. That profile contains
metadata and patch bytes only; it contains no proprietary binary. It must not
be renamed to or substituted for a `blue.dll` profile. Unsupported hashes fail
closed.

### Root PowerShell tools

- `SetupFrontierWindows.ps1` coordinates prerequisites, dependencies,
  extraction, contracts, database generation, certificates, and staging.
- `StageFrontierClient.ps1` creates or safely removes only a marker-owned
  build-numbered stage.
- `PatchFrontierClientTrust.ps1` applies the transaction or runs `-Check`.
- `StartFrontierServer.ps1` initializes/reuses the isolated runtime and starts
  loopback-only services with the market disabled.
- `PlayFrontier.ps1` checks and launches only the staged client.
- `CaptureFrontierSession.ps1` captures a launcher session without printing
  credentials and restricts the session-file ACL.
- `StopFrontier.ps1` stops only a verified background server PID.

All support `-Status`, `-Check`, or `-DryRun` where applicable. See
[FRONTIER_WINDOWS_SETUP.md](FRONTIER_WINDOWS_SETUP.md) for command examples and
the current partial live-validation boundary.

## Conventional EVE Online tools (build 3396210)

If you are just here to play, you only need a small part of it.

### Tools Most People Will Actually Use

#### `tools\ClientSETUP`

Use this for first-time setup.

Launcher:

```text
tools\ClientSETUP\StartClientSetup.bat
```

This is the main setup wizard. It is the most important tool in the repo for normal users.

#### `tools\ConfigEditor`

Use this if you want to edit local server settings or local data through a desktop window.

Launcher:

```text
tools\ConfigEditor\OpenServerConfig.bat
```

Good for:

- changing local server settings
- adjusting local data without digging through files by hand

#### `tools\market-seed`

Use this only if you want the optional standalone market server.

Easy launcher:

```text
BuildMarketSeed.bat
```

Good for:

- building the market database
- rebuilding the seed after config changes
- using the Jita + New Caldari preset

#### `tools\NewEdenStoreEditor`

Use this if you want to edit store content.

Launcher:

```text
tools\NewEdenStoreEditor\StartStoreEditor.bat
```

This tool needs Python 3.

### Tools Most Players Can Ignore

#### `tools\ClientCodeGrabber`

This is a maintainer tool, not a normal player setup tool.

It is used for refreshing client reference/code snapshots for development work.

If you are just trying to set up EvEJS and play, you do not need it.

### The Simple Rule

If you are not sure what to use:

1. use `tools\ClientSETUP\StartClientSetup.bat`
2. use `StartServer.bat`
3. ignore the rest until you actually need them

## Related Guides

- [SETUP.md](SETUP.md)
- [FRONTIER_WINDOWS_SETUP.md](FRONTIER_WINDOWS_SETUP.md)
- [LAUNCHERS.md](LAUNCHERS.md)
- [MARKET_SETUP.md](MARKET_SETUP.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
