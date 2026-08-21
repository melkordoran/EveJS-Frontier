# EVE Frontier on Windows

This guide covers the native, isolated Windows workflow for the exact EVE
Frontier build `3474408` candidate. It does not cover conventional EVE Online
build `3396210`.

> Live acceptance is partial. Static extraction, contract export, database
> generation, exact binary analysis, staged verification, automated suites,
> loopback listener checks, and a LogLite-assisted session-free run have passed.
> That run reached login, character selection/creation, rendered station and
> space, docking, XMPP, and the secure gateway. Flight/warp and the complete
> Creation, Smart Storage, Heavy Gate, and HUD/map matrix still need a live pass,
> so do not yet describe this Windows build as fully supported.

## Keep the two Windows workflows separate

The following existing files target conventional EVE Online build `3396210`,
the `tq` layout, and its own `blue.dll` recipe:

- `SetupEveJS.bat`
- `tools\ClientSETUP\ClientSetup.ps1`
- `tools\ClientSETUP\blue_patch_recipe.json`
- `Play.bat`
- `StartServer.bat`

Do not point those tools at Frontier. Windows Frontier build `3474408` ships
the Python extension `bin64\blue.pyd`; it has no `bin64\blue.dll`. The Frontier
manifest also names `root:/bin64\blue.pyd`.

## Proven build identity

The client currently used to derive this profile reported:

| Field | Value |
|---|---|
| App | `FRONTIER` |
| Build and sync | `3474408` |
| Version | `20.04` |
| Branch | `//frontier/cycle-6` |
| Codename | `cycle-6` |
| Region | `ccp` |
| MachoNet | `489` |
| Birthday | `170472` |
| Native Python | `3.12.9` AMD64 |

The version, cycle, MachoNet version, and birthday match the last accepted
build `3467658`; the build and sync numbers advanced. The current static
snapshot contains 24,026 systems, 113,253 landscape sites, 32,623 types, and
7,072 stargates. That is 15 more types than the recorded `3467658` counts; the
other three counts are unchanged. The old build's JSONL and descriptor outputs
are not available locally, so the identities of those 15 types and byte-for-
byte protobuf/module equivalence cannot be established from the available
baseline. The `3474408` export contains 163 descriptor files with no failures
and an inventory of 239 client modules.

Key untouched source hashes are:

| Official file | SHA-256 |
|---|---|
| `start.ini` | `c725f9e074d218f3989669995db2fd4d60853d8ce9f46c6d3995ecb6ced6627f` |
| `bin64\exefile.exe` | `71eea118eb45a7541a3d601efadb7990a0aeff982c42d20a83793d4353eed0cb` |
| `bin64\blue.pyd` | `86f543d962e7531d1b47decc10498731927d32d28478fbc325d77807f67fc397` |
| `code.ccp` | `1e5120ad571e7988dfd19d8713276284931ec690d9fea8aabe95c9c37d6ffe82` |
| `manifest.dat` | `5035705adcd8143573b3b593a93b6c641606690bbe5ff3cdd4420681212b082f` |
| either retail CA bundle | `54abc073292ab1b3ea95361d7e9fbc0fdf3c2b74777f0a4e2b6ec26670f0a453` |

These hashes are profile evidence, not a reason to patch an arbitrary file.
Discovery and staging hash the actual official client before copying it, and
the read-only check re-hashes it afterward.

## Prerequisites

Use a normal PowerShell 7 session. Elevation is normally unnecessary; use it
only if Windows requires it for a missing prerequisite.

- Git for Windows
- PowerShell 7
- Node.js 24 LTS x64 and npm
- CPython 3.12 x64 exactly, not Python 3.13 or newer

`SetupFrontierWindows.ps1` installs a missing Git, Node, or Python package with
`winget`, installs locked root and server npm dependencies, and opens an in-
memory `better-sqlite3` database to prove the active Node ABI. It creates the
ignored `_local\frontier-python312` environment and installs the pinned
dependencies in `tools\frontier-client\requirements-windows-frontier.txt`.

The extractor first probes external CPython 3.12 with `PYTHONPATH` rooted at
the client's `code.ccp` and `bin64` and with DLL lookup in `bin64`. If that
cannot load the native client modules, it can build a small runner that loads
the client's `python312.dll` dynamically. Only that fallback requires Visual
Studio 2022 C++ Build Tools and a Windows SDK.

Rust, Docker, the market service, the SQLite command-line tool, and OpenSSL are
not required. The Frontier server explicitly disables the market daemon.

## Discover the official client

Discovery accepts either a launcher/cache root or the build directory itself:

```powershell
npm run frontier:discover -- --client-root 'C:\CCP\EVE Frontier\stillness'
```

Without `--client-root`, it checks likely launcher-cache locations. A valid
candidate must have `appname=FRONTIER`, a numeric build, `bin64\exefile.exe`,
`bin64\blue.pyd` or `blue.dll`, `code.ccp`, `manifest.dat`,
`resfileindex.txt`, `bin64\staticdata\mapObjects.db`, and a resolvable
`ResFiles` tree. If the highest build occurs in more than one distinct valid
root, discovery refuses to choose. Use `-SourceRoot` with the PowerShell
scripts to remove that ambiguity.

Discovery and extraction read the official client. They do not write to it.

## Setup, status, and dry runs

From the repository root:

```powershell
.\SetupFrontierWindows.ps1 -Status
.\SetupFrontierWindows.ps1 -DryRun -SourceRoot 'C:\CCP\EVE Frontier\stillness'
.\SetupFrontierWindows.ps1 -NonInteractive -SourceRoot 'C:\CCP\EVE Frontier\stillness'
```

The `.bat` wrapper is equivalent and bootstraps PowerShell 7 when necessary:

```text
SetupFrontierWindows.bat -Status
```

`-Status` reports prerequisites, installed client discovery, stage status, and
runtime status without mutation. `-DryRun` resolves and hashes inputs and
describes the intended stage. `-SkipStage` stops after dependencies,
certificates, extraction, contracts, validation, and database generation.
`-ForceData` replaces only extractor/exporter-owned build outputs. Use
`-CopyResFiles` when the shared-cache junction is not acceptable.

The build-numbered ignored outputs are:

```text
_local\frontier-python312
_local\frontier-sde\3474408
_local\frontier-contracts\3474408
_local\frontier-gameStore\3474408\data
_local\frontier-runtime\3474408\gameStore
```

## Isolated client stage

The default stage is:

```text
%LOCALAPPDATA%\EveJS-Frontier\windows\staged-client\3474408
```

Create it separately when needed:

```powershell
.\StageFrontierClient.ps1 -Build 3474408 -SourceRoot 'C:\CCP\EVE Frontier\stillness'
```

The script copies the build tree to a temporary path, verifies the copied
hashes, adds a stage-only `common.ini` containing `cryptoPack = Placebo`, and
atomically moves the result into its build-numbered location. The official
client is hashed before and after staging.

The default `ResFiles` mode is a junction to the official shared cache. This
does not make the cache read-only; it only avoids a second large copy. The
launcher uses it as a remote-file cache and the patch transaction never
mutates it. `-CopyResFiles` instead copies the complete tree into the stage for
full isolation.

The marker `.evejs-frontier-stage.json` records ownership and containment,
source and stage paths, original and current hashes, exact profile builds,
enabled features, certificate fingerprint, `ResFiles` mode and target, backup
location, and Placebo mode. `-Clean` removes only a recognized, marker-owned,
build-numbered path inside the configured staging base and refuses unexpected
junctions, malformed metadata, reparse-point path escapes, or an active exact
staged-client process (with or without its PID marker).

## Exact `blue.pyd` policy

The profile `tools\frontier-client\blue-pyd.3474408.patch.json` accepts only
the full exact source or full exact target. Partial, unknown, and other-build
files fail; there is no pattern scan or “attempt anyway” mode.

The AMD64 PE analysis identified one verifier result-normalization instruction
at file offset `0x00196846` (RVA `0x00197446`). The exact bytes change from
`0f95c0` (`setne al`) to `b00190` (`mov al,1; nop`). The preceding signed
branch still preserves negative verifier errors. The source and deterministic
target are:

| State | Size | SHA-256 |
|---|---:|---|
| Exact signed source | 6,094,480 | `86f543d962e7531d1b47decc10498731927d32d28478fbc325d77807f67fc397` |
| Exact patched target | 6,084,096 | `2dcfd00d4b84534abecf7f4cb3be09209fb2bac85377066cb8e18fe32131de82` |

The source Authenticode certificate is a proven PE certificate overlay from
`0x005CD600` to EOF. After the content change, the patcher strips exactly that
overlay, zeros the PE security directory, recalculates checksum `0x005CE796`,
re-reads the temporary file, verifies the full target hash, and atomically
replaces only the staged file. `exefile.exe` is never changed and must retain a
valid Authenticode signature.

The same transaction applies exact build-specific docking and selected feature
bytecode changes to staged `code.ccp`, appends the EveJS public CA exactly once
to each staged CA bundle, and refreshes only the real 32-byte digest spans in
manifest version 4. Its trailer must remain byte-for-byte unchanged.

Before mutation, every touched file and the marker are copied to:

```text
<stage>\.evejs-backups\frontier-client-<timestamp>
```

Any failure restores and re-hashes every touched file, retains the backup, and
does not write a success marker.

## Certificates and independent check

Setup generates or reuses one EveJS CA and XMPP and secure-gateway leaf
certificates. Only the public CA is installed in `Cert:\CurrentUser\Root`.
Private-key ACL inheritance is removed and access is restricted to the current
SID. Both staged CA bundles must contain the same EveJS CA exactly once, and
both leaf certificates must verify against it.

Run the independent check before every launch:

```powershell
$stage = "$env:LOCALAPPDATA\EveJS-Frontier\windows\staged-client\3474408"
.\PatchFrontierClientTrust.ps1 -StagedRoot $stage -Check
```

For a non-mutating structural preview:

```powershell
.\PatchFrontierClientTrust.ps1 -StagedRoot $stage -Check -DryRun
```

The full `-Check` verifies real files, not just marker claims: exact native
target, code profiles, manifest targets and trailer, CA counts and chains,
backup hashes, `ResFiles`, Placebo configuration, CurrentUser root trust,
valid staged `exefile.exe` Authenticode, and unchanged official hashes.

## Server and daily launch

Start the server in the foreground by default:

```powershell
.\StartFrontierServer.ps1 -Build 3474408
```

The fresh runtime is initialized from new-build generated data. The server
refuses missing or mismatched build markers and refuses to start if a required
port is already occupied. It binds these listeners to loopback:

| Listener | Purpose |
|---|---|
| `127.0.0.1:26000` | Game TCP |
| `127.0.0.1:26101` | Image HTTP |
| `127.0.0.1:26102` | HTTP and bridge |
| `127.0.0.1:26103` | Secure public gateway |
| `127.0.0.1:5222` | XMPP |
| `127.0.0.1:26401` | Monitor |

Check the actual listener addresses after startup:

```powershell
$ports = 26000,26101,26102,26103,5222,26401
Get-NetTCPConnection -State Listen |
    Where-Object LocalPort -In $ports |
    Sort-Object LocalPort |
    Format-Table LocalAddress,LocalPort,OwningProcess
```

Launch the client only through the project script, which first runs the staged
check and then sets the working directory, Placebo arguments, local resource
cache, secure gateway environment, and JSONL log path:

```powershell
.\PlayFrontier.ps1 -Build 3474408
```

Foreground is the default. Session-free launch is attempted first. Use
`CaptureFrontierSession.ps1` only if a launcher session is required; it selects
exactly one official `exefile.exe`, never displays token values, writes an
ignored current-user-only file, and the launcher redacts sensitive arguments
when reporting its command line.

`StartFrontierServer.ps1 -Background` records the exact child identity. Stop
only that marker-owned process:

```powershell
.\StopFrontier.ps1 -Build 3474408
```

`StopFrontier.ps1 -Status` and `-DryRun` are read-only. It never terminates all
Node or EVE processes. A foreground server stops with `Ctrl+C`; close a
foreground client normally.

## Runtime upgrades, backup, and restore

Builds never share static data or runtimes. `StartFrontierServer.ps1` does not
migrate an older runtime automatically. Never point a new build at an old
`gameStore\data` tree and never copy SQLite WAL or SHM files.

For an upgrade:

1. Stop the old server and keep its entire build-numbered runtime intact.
2. Create a consistent SQLite online backup of
   `_local\frontier-runtime\<old>\gameStore\gamestore.sqlite` with the installed
   `better-sqlite3` module. Do not copy a live database or its `-wal`/`-shm`.
3. Generate the new build's static snapshot and database.
4. Run `StartFrontierServer.ps1 -Build <new> -InitializeOnly` to create a new
   runtime from new-build static data.
5. With both servers stopped, restore only the backed-up mutable SQLite state
   and the old runtime's `gameStore\images` into the new runtime.
6. Run `PRAGMA integrity_check`, record important table counts, then start the
   explicit new build and verify those counts again.
7. Retain the old runtime until live acceptance succeeds.

`-ResetRuntime` is intentionally destructive. It accepts only the exact,
marker-owned build runtime, rejects reparse points in the path or tree, and
refuses any PID marker, exact Frontier server process, or active required
listener. It repeats those checks immediately before deletion, then
reinitializes from generated data. Do not use it during an upgrade.

## Logs and validation

Relevant logs and evidence are:

```text
server\logs\server.log
_local\frontier-runtime\3474408\server.stdout.log   # background server
_local\frontier-runtime\3474408\server.stderr.log   # background server
%LOCALAPPDATA%\EveJS-Frontier\windows\logs\3474408\logs-client.jsonl
%LOCALAPPDATA%\EveJS-Frontier\windows\logs\3474408\client-stdout.log
%LOCALAPPDATA%\EveJS-Frontier\windows\logs\3474408\client-stderr.log
```

The stdout/stderr client files exist only in background mode. EVE LogLite is
started through EVE Launcher → cogwheel → Tools → Start LogLite.

Automated acceptance includes PowerShell parser checks, Python compilation and
unit tests, Node syntax and focused Windows tests, `npm run
test:frontier-static`, the explicit build Frontier server suite, and `git diff
--check`. The live run must then cover handshake, login and character
selection/creation, rendered space, movement and warp, docking, Creation
fitting and reload/unload, XMPP, the secure gateway, Smart Storage, Heavy Gate,
and HUD/map calls. Review LogLite, client logs, and `server.log` for manifest,
decrypt, certificate-chain, handshake, unknown-build, and unhandled-service
errors, then re-hash the official client.

The post-hardening run passed 16/16 PowerShell parser checks, 12/12 Python
compilation checks, 15/15 Python unit tests, 1,028/1,028 Node syntax checks,
28/28 static tests, 216/216 build-`3474408` server tests, 14/14 Windows Node
tests (plus the same 15/15 Python phase), 6/6 runner tests, 2/2 isolated-helper
tests, and `git diff --check`.

The completed Windows `3474408` live pass proved the exact client handshake
(`20.04`, build `3474408`, birthday `170472`, MachoNet `489`,
`cycle-6@ccp`), login and character creation/selection, rendered station and
space, undock and station docking, XMPP, and TLS/H2 public-gateway streams. It
also exposed post-startup service gaps that were fixed against the exact client
contracts and covered by automation. A live recheck of those fixes plus
movement/warp, Creation fitting and reload/unload, Smart Storage, Heavy Gate,
and HUD/map calls remains outstanding; this is still a candidate rather than a
claim of complete gameplay support.
