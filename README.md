# EVE.js

EVE.js is a local EVE Online server emulator. This release targets **EVE 24.01 build 3396210**, validated against the client and static-data export from June 16, 2026.

Join the project Discord: [https://discord.gg/KMuJrMDEBa](https://discord.gg/KMuJrMDEBa)

## EVE Frontier compatibility fork

This checkout contains an experimental, isolated EVE Frontier compatibility
profile. The last live-accepted macOS target is build `3467658`; Windows build
`3474408` now has exact extraction, bytecode, and `blue.pyd` profiles. A
LogLite-assisted session-free smoke run completed the exact handshake, login,
character creation/selection, rendered station and space, station docking,
XMPP, and the secure public gateway. The remaining flight/warp, Creation
reload/unload, Smart Storage, Heavy Gate, and HUD/map interactions still need a
complete live pass, so the Windows profile remains a candidate. Each workflow
extracts static data from the locally installed client, stages a separate
client copy, and leaves the retail client and normal EveJS installation
untouched.

The live-accepted macOS profile reaches character creation and selection,
rendered space, native flight and warp, modular Creation fitting, local XMPP, deployables,
Refuge berthing, Heavy Gate travel, and Smart Storage. See
[milestone three](doc/FRONTIER_MILESTONE_3.md) for the implemented surface and
known limits. [Milestone one](doc/FRONTIER_MILESTONE_1.md) and
[milestone two](doc/FRONTIER_MILESTONE_2.md) preserve the original handshake
and character-selection history.

> The Frontier Windows scripts are not the conventional EVE Online Windows
> wizard. `SetupEveJS.bat`, `tools\ClientSETUP\ClientSetup.ps1`, `Play.bat`,
> and `StartServer.bat` target EVE Online build `3396210` and its `tq` layout.
> Never use their `blue.dll` recipe against a Frontier installation.

### Frontier Windows quickstart (build 3474408 candidate)

The Windows workflow is native: the server and staged client run on the same
Windows machine. The exact build `3474408` profile uses `bin64\blue.pyd`, not
`blue.dll`. Unknown hashes, partial patches, another build, or a manifest with
unexpected entries fail closed.

Requirements:

- Git for Windows and PowerShell 7;
- Node.js 24 LTS x64 with npm;
- CPython 3.12 x64 exactly (not Python 3.13 or newer);
- an installed Frontier build with `appname=FRONTIER` and a resolvable shared
  `ResFiles` tree.

Visual Studio 2022 C++ Build Tools and the Windows SDK are only needed if the
external Python 3.12 probe cannot use the client loaders and the minimal
embedded-Python runner must be compiled. Rust, Docker, OpenSSL, the SQLite CLI,
and the market daemon are not part of the default Frontier Windows path.

Open PowerShell 7 in the repository root. Discovery is automatic, or pass the
actual build directory explicitly with `-SourceRoot`:

```powershell
.\SetupFrontierWindows.ps1 -Status
.\SetupFrontierWindows.ps1 -DryRun -SourceRoot 'C:\CCP\EVE Frontier\stillness'
.\SetupFrontierWindows.ps1 -NonInteractive -SourceRoot 'C:\CCP\EVE Frontier\stillness'
```

The setup installs only missing prerequisites, runs the locked npm installs,
proves `better-sqlite3` under the active Node ABI, creates the ignored
`_local\frontier-python312` environment, extracts and validates build-numbered
data and contracts, generates the database, creates/reuses local certificates,
and builds the isolated client stage. `SetupFrontierWindows.bat` is a thin
wrapper that can install PowerShell 7 and invoke the same script.

The default stage is:

```text
%LOCALAPPDATA%\EveJS-Frontier\windows\staged-client\3474408
```

By default its `ResFiles` entry is a junction to the official shared cache.
That saves roughly the size of a second resource cache, but it is shared and
not OS-enforced read-only. Add `-CopyResFiles` for a complete copy. Every other
client file is copied before mutation, and the stage marker records the
official hashes. Cleanup accepts only a marker-owned, build-numbered path under
the staging base.

Verify an existing stage independently before starting the client:

```powershell
$stage = "$env:LOCALAPPDATA\EveJS-Frontier\windows\staged-client\3474408"
.\PatchFrontierClientTrust.ps1 -StagedRoot $stage -Check
```

The check requires the exact patched `blue.pyd`, exact docking and selected
feature bytecode, Placebo boot configuration, both CA bundles, certificate
chains, manifest target digests and untouched trailer, a complete transaction
backup, valid `exefile.exe` Authenticode, the correct `ResFiles` target, and
unchanged official-client hashes. The patched `blue.pyd` intentionally no
longer has its original Authenticode overlay; `exefile.exe` remains unmodified
and signed.

For daily use, start the explicit build server in one PowerShell and keep it in
the foreground:

```powershell
.\StartFrontierServer.ps1 -Build 3474408
```

In another PowerShell, launch only through the checked stage:

```powershell
.\PlayFrontier.ps1 -Build 3474408
```

Session-free launch is the default. If it proves insufficient, start the
official client from the EVE Launcher, capture only that process's arguments,
then replay the current-user-only file without printing credentials:

```powershell
.\CaptureFrontierSession.ps1 -SourceRoot 'C:\CCP\EVE Frontier\stillness'
.\PlayFrontier.ps1 -Build 3474408 -UseCapturedSession
```

Use `Ctrl+C` to stop a foreground server and close a foreground client
normally. For a server started with `-Background`, stop only its recorded PID:

```powershell
.\StopFrontier.ps1 -Build 3474408
```

The server does not run or require the market daemon and binds the game, image,
HTTP/bridge, secure gateway, XMPP, and monitor listeners to `127.0.0.1` only.
See [Frontier Windows setup](doc/FRONTIER_WINDOWS_SETUP.md) for exact hashes,
paths, upgrades, backup policy, port checks, and current validation status.

### Frontier macOS quickstart (build 3467658)

The Frontier profile is a native macOS development workflow. Run the server
and client on the same Mac and keep every listener on `127.0.0.1`.

Requirements:

- an installed EVE Frontier client whose build has an exact
  `tools/frontier-client/blue-so.<build>.patch.json` profile and matching
  exact-build docking/feature bytecode fingerprints;
- Node.js, npm, OpenSSL, and Python 3.12;
- macOS `ditto`, `xattr`, `codesign`, and `security` tools.

From the repository root, extract and validate the installed build, then create
the generated database. These outputs are build-numbered and ignored by Git:

```bash
BUILD=3467658
npm ci
npm run frontier:extract -- --build "$BUILD"
npm run frontier:validate -- --snapshot "_local/frontier-sde/$BUILD"
npm run frontier:database -- --snapshot "_local/frontier-sde/$BUILD"
npm run frontier:contracts -- --build "$BUILD"
npm run test:frontier-static
```

Start the server in the first terminal. Initial startup creates an isolated
runtime and the local CA used by the staged client:

When upgrading an existing Frontier world, stop the old server and migrate a
consistent backup of its mutable `gamestore.sqlite` into the new build's
runtime while retaining the new build's generated `gameStore/data` tree.
`StartFrontierServer.sh` does not migrate older runtimes automatically. Keep
the old build-numbered runtime intact and never use `--reset-runtime` during an
upgrade.

```bash
bash StartFrontierServer.sh --build "$BUILD"
```

Leave it running. In a second terminal, create and verify the isolated client
copy. The retail app is not patched; only its large `ResFiles` directory is
linked into the stage and left unmodified:

```bash
bash StageFrontierClient.sh --build "$BUILD"
bash PatchFrontierClientTrust.sh \
  --staged-root "$HOME/Library/Application Support/evejs-frontier/macos/staged-client/current" \
  --check
npm run test:frontier-server
```

Launch only through the project script so the staged resource cache, secure
local public gateway, settings profile, and Placebo crypto mode are applied:

```bash
bash PlayFrontier.sh --server-host 127.0.0.1 --foreground
```

If the official launcher session is required, capture it without printing its
tokens, then opt into replay:

```bash
bash CaptureFrontierSession.sh --open-launcher
bash PlayFrontier.sh --use-captured-session --foreground
```

For daily use, start `StartFrontierServer.sh` first and `PlayFrontier.sh`
second. Do not launch `exefile` directly, expose the local ports to a LAN, use
an older binary patch profile on a newer build, or pass `--reset-runtime`
unless discarding the isolated world is intentional. Client updates require a
new exact-build patch profile and a new build-numbered static snapshot.

## Localhost only

> **EVE.js is a localhost-only project. Run the server and EVE client on the same computer.** It is not hardened for a LAN, the public Internet, port forwarding, shared hosting, or untrusted users.

The supported address is `127.0.0.1`. The Docker configuration publishes every required port specifically on `127.0.0.1`, and native listener defaults are also loopback-only. Do not remove the `127.0.0.1:` prefixes from `compose.yaml`, change bind settings to `0.0.0.0` on the host, or forward these ports through your router.

## Recommended setup: Docker

Docker is the easiest backend setup. It builds a Linux image containing:

- the Node.js game server;
- the Rust market daemon plus both v1 and v2 market seed engines;
- automatic first-run static game-data initialization;
- persistent game and market SQLite databases.

The Windows EVE client still runs directly on your computer; it does not run inside the Linux container.

### Requirements

- Windows with Docker Desktop in **Linux containers** mode;
- a full copied EVE shared cache for build `3396210` (the copy must include `EVE\tq`, `ResFiles`, and `index_tranquility.txt`);
- free local ports `443`, `5222`, `26000`–`26002`, and `40110`;
- Internet access on the first start for image dependencies and the approximately 80 MB EVE SDE download.

Use a copied EVE installation. Do not patch the same installation you use for normal live play.

### 1. Build the Linux image

Open PowerShell in this project folder and confirm Docker is using Linux containers:

```powershell
docker info --format '{{.OSType}}'
```

It should print `linux`. Build the shared local image:

```powershell
docker compose build init
```

The equivalent image-only build command is:

```powershell
docker build --tag evejs-local .
```

### 2. Choose and build the market once

There is one Rust market daemon and two ways to populate its SQLite database. Docker never chooses or replaces a market during normal startup. List the choices:

```powershell
docker compose run --rm --no-deps market-tools engines
```

For the recommended fast, repeatable synthetic market:

```powershell
docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_new_caldari
```

Alternatively, use the latest EVE Ref Tranquility station-market snapshot:

```powershell
docker compose run --rm --no-deps market-tools rebuild v2 `
  --order-filter market-scope-with-npc `
  --market-solar-system-id 30000142
```

The first rebuild also downloads the approximately 80 MB EVE SDE and generates the static game tables. V2 additionally downloads the current market snapshot.

### 3. Start the backend

```powershell
docker compose up --detach
```

Follow progress with:

```powershell
docker compose logs --follow init market server
```

Press `Ctrl+C` to stop following logs; the containers keep running. The backend is ready when `docker compose ps --all` shows `market` and `server` as healthy and `init` as exited with code `0`:

```powershell
docker compose ps --all
```

### 4. Prepare the Windows client once

After the Docker server is healthy, run:

```text
SetupEveJS.bat
```

Choose the Docker option. It confirms the containers are healthy and that the certificates the container generated have landed on the host, then opens the client wizard. To run the wizard directly instead:

```text
tools\ClientSETUP\StartClientSetup.bat
```

Select the copied build `3396210` shared-cache folder. The wizard patches the copied client, points it at `127.0.0.1`, and trusts the same local CA that the container generated. Docker bind-mounts the certificate folders into the project so that certificate identity survives container recreation.

### 5. Play

Keep the Docker backend running, then launch the client on Windows:

```text
Play.bat
```

### Daily Docker use

```powershell
# Start or resume the backend
docker compose up --detach

# Check health
docker compose ps

# Follow server and market logs
docker compose logs --follow server market

# Stop the backend but keep all data
docker compose down
```

After pulling project updates, rebuild without resetting data:

```powershell
docker compose up --build --detach
```

Normal startup preserves both databases. The initializer only creates missing static game data; market creation and replacement happen exclusively through the explicit `market-tools rebuild` commands below because the market database also contains player orders and history.

### Market seed engines and maintenance

V1 and v2 are seed engines, not different market daemons. Both produce `market.sqlite` for the same Rust server.

| Engine | Source | Best use |
|---|---|---|
| `v1` | Deterministic synthetic prices and quantities from local static data | Fast, repeatable local worlds |
| `v2` | Latest EVE Ref Tranquility station-order snapshot | TQ-like station liquidity and NPC stock |

V1 supports `jita_new_caldari`, `jita_only`, `new_caldari_only`, and `full_universe`. List them with:

```powershell
docker compose run --rm --no-deps market-tools presets
```

> **Size warning:** `full_universe` can produce hundreds of millions of rows. It is not recommended for ordinary local use.

V2 supports `all-station`, `npc-only`, `player-only`, `market-scope`, and `market-scope-with-npc`. It imports station orders only; player-structure orders are excluded. Inspect the currently published source snapshot without rebuilding:

```powershell
docker compose run --rm --no-deps market-tools snapshot-info
```

V2 reuses the current matching snapshot from the persistent download cache by default. Add `--fresh-download` to a v2 rebuild command to ignore that cache and download the snapshot again.

#### Rebuild an existing market

> **Destructive operation:** a market rebuild replaces seeded liquidity, player orders, order events, consumed stock, and market history. The tool automatically retains a timestamped backup of the previous valid database, but you should still treat this as maintenance and log players out first.

Stop both runtime services, run exactly one rebuild, then start them again:

```powershell
docker compose stop server market

# Synthetic v1 example
docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_only

# OR snapshot-based v2 example
docker compose run --rm --no-deps market-tools rebuild v2 `
  --order-filter market-scope-with-npc `
  --market-solar-system-id 30000142

docker compose up --detach market server
```

The market daemon and rebuild command use a volume lock. A rebuild refuses to run while the market container still has the database open. Candidates are built and validated separately, the existing database is backed up, and only then is the candidate installed.

#### Inspect, back up, and restore the market

```powershell
# Manifest, row counts, SQLite validation, and backup count
docker compose run --rm --no-deps market-tools status

# Full Rust daemon validation; stop server and market first
docker compose stop server market
docker compose run --rm --no-deps market-tools doctor

# Create a named backup while they remain stopped
docker compose run --rm --no-deps market-tools backup before-experiment

# List retained backups
docker compose run --rm --no-deps market-tools backups

# Restore the newest backup, then restart
docker compose run --rm --no-deps market-tools restore latest
docker compose up --detach market server

# Show every market-tools command
docker compose run --rm --no-deps market-tools help
```

Backups live under `/var/lib/evejs/market/backups` in the persistent `evejs-data` volume.

Runtime market inspection is also available while the backend is running:

```powershell
curl.exe http://127.0.0.1:40110/health
curl.exe http://127.0.0.1:40110/v1/manifest
curl.exe http://127.0.0.1:40110/v1/diagnostics
```

The `/v1/` URL is the HTTP API version; it is unrelated to the v1/v2 seed-engine choice.

### Docker command reference

| Task | Command |
|---|---|
| Build the image | `docker compose build init` |
| Start everything | `docker compose up --detach` |
| Show all service states | `docker compose ps --all` |
| Follow runtime logs | `docker compose logs --follow server market` |
| Restart Node only | `docker compose restart server` |
| Stop runtime services | `docker compose stop server market` |
| Stop containers but retain data | `docker compose down` |
| Open a shell in Node | `docker compose exec server sh` |

### Changing `evejs.config.local.json`

Edit `evejs.config.local.json` in the project root. It allows `//` and block comments, but otherwise uses JSON syntax, so trailing commas are invalid. Each generated setting documents its purpose, accepted values, and default.

The file is copied into the Linux image. Apply host-side changes by rebuilding and recreating the backend:

```powershell
docker compose up --build --detach
```

`docker compose restart` alone does not copy a changed host config into an existing image. Most settings are loaded at Node startup.

Configuration precedence is:

```text
code defaults < evejs.config.json < evejs.config.local.json < EVEJS_* environment variables
```

Use `evejs.config.local.json` for gameplay, economy, NPC, feature, and logging settings. Compose intentionally overrides container plumbing such as bind hosts, localhost-facing URLs, the market daemon address, and the persistent data path. Changing ports or networking therefore also requires matching changes in `compose.yaml`, health checks, and sometimes client setup. Host publications must remain prefixed with `127.0.0.1:`.

Rust market runtime and seeder tuning are separate from the Node JSON configuration. Routine seed selection belongs in the `market-tools rebuild` arguments; advanced defaults live in `docker/market-server.toml`, `docker/market-seed.toml`, and `docker/market-seed-v2.toml` and require an image rebuild.

### Docker persistence

Both SQLite databases, retained market backups, downloaded snapshots, generated static data, and uploaded character portraits and alliance logos live in the named volume `evejs-data`. Normal `stop`, `down`, image rebuild, and container replacement operations preserve it. See [Upgrading and moving your server](#upgrading-and-moving-your-server) for the steps to carry it to a new version, folder, or PC.

> **Data-loss warning:** `docker compose down --volumes` deletes the entire Docker world state, including accounts, characters, inventory, and market state. Use it only when you intentionally want a completely fresh server.

Docker data is separate from the native `_local\gameStore` and `externalservices\market-server\data\generated` paths. Existing native state is not imported automatically.

> **Upgrading from a version whose `compose.yaml` bind-mounted `./_local/gameStore`:** on those versions the live game store was the `_local/gameStore` folder in the install directory, not the volume. Before starting this version, import that folder into the volume once (from the old install folder, with everything stopped):
>
> ```
> docker run --rm -v evejs-data:/data -v "${PWD}/_local/gameStore:/src" alpine sh -c "mkdir -p /data/gameStore && find /data/gameStore -mindepth 1 -delete && cp -a /src/. /data/gameStore/ && chown -R 1000:1000 /data/gameStore"
> ```
>
> Skip this on fresh installs, or if your `_local/gameStore` has no `gamestore.sqlite`.

### Local ports

| Local address | Purpose |
|---|---|
| `127.0.0.1:26000` | Main game TCP server |
| `127.0.0.1:26001` | Image server |
| `127.0.0.1:26002` | Local HTTP proxy and gateway |
| `127.0.0.1:443` | Local HTTPS assets used by the client |
| `127.0.0.1:5222` | XMPP chat |
| `127.0.0.1:40110` | Rust market health and diagnostics |

The Rust RPC port `40111` stays private inside the Docker network.

## Native Windows setup (EVE Online build 3396210)

This section is for conventional EVE Online build `3396210`, not EVE Frontier.
Use this path only if you do not want Docker. It requires more host tooling and
more separate steps.

### Requirements

- Node.js 24 LTS;
- the full copied EVE build `3396210` shared cache;
- Internet access for npm, the SDE, Rust, and build-tool downloads;
- administrator permission for certificate installation and native build tools.

### First-time setup

Run one launcher:

```text
SetupEveJS.bat
```

It installs the packages, generates the certificates, builds the local database, offers the optional market, and finally opens the client wizard — in that order, because the order matters. Re-run it any time: every step checks what is already done and only fills in what is missing. `SetupEveJS.bat -Status` reports where you are without changing anything.

The Rust installer (offered by the optional market step) may install the MSVC Rust toolchain, Visual Studio C++ Build Tools, and a Windows SDK. Native server listeners default to `127.0.0.1`; keep all bind-host settings on loopback.

<details>
<summary>The individual launchers, if you prefer to run them yourself</summary>

```powershell
npm ci
npm --prefix server ci
```

1. `tools\ClientSETUP\StartClientSetup.bat`
2. `tools\DatabaseCreator\CreateDatabase.bat`
3. `tools\InstallRustForMarket.bat`
4. `BuildMarketSeed.bat` — choose **Jita + New Caldari**
5. `StartMarketServer.bat` — choose the release-server option
6. `StartServer.bat` — choose **Server + Play**

</details>

### Daily native use

1. Run `StartMarketServer.bat` and leave it open.
2. Run `StartServer.bat` and choose **Server + Play**.
3. Use `Play.bat` when the backend is already running.

To rebuild only the native game database:

```text
tools\DatabaseCreator\CreateDatabase.bat /force
```

Market reseeding replaces the market SQLite database, including live player market state. Back it up before deliberately reseeding.

## Upgrading and moving your server

Everything your server remembers — accounts, characters, ships, wallets, uploaded portraits, and market state — is kept separately from the program files. Upgrading is therefore always the same idea: **replace the program files, keep the data.** You never need to rebuild the game database to install a new version.

### Where your data actually lives

**Docker** keeps everything in one named volume called `evejs-data`. The volume is found by name, not by folder, so you can move or replace the install folder freely and the same world comes back.

| Inside the volume | What it holds |
|---|---|
| `/var/lib/evejs/gameStore/` | game database, characters, and uploaded portraits and alliance logos |
| `/var/lib/evejs/market/` | market database and its retained backups |
| `/var/lib/evejs/sde/` and `/var/lib/evejs/downloads/` | static data and cached downloads |

**Native Windows** keeps everything inside the install folder. These are the parts to carry forward:

| In the install folder | What it holds |
|---|---|
| `_local\gameStore\` | game database, characters, and uploaded portraits and alliance logos |
| `externalservices\market-server\data\generated\` | market database |
| `evejs.config.local.json` | your server settings |

> **Upgrading from a version released before 25 July 2026:** uploaded character portraits used to be written into the program files, at `server\src\_secondary\image\generated\Character`. That is why they were left behind whenever an install was copied to a new folder, and why rebuilding a Docker container erased them. They now live in `_local\gameStore\images`, beside the game database, so they travel with everything else. The steps below include the one-time copy that brings old portraits across; the server keeps reading the old location in the meantime, so nothing breaks if you upgrade first and migrate later.

### Upgrading Docker

If the old version stored portraits in the program files (see the note above), rescue them **first**, in the old install folder, while its containers still exist — `docker compose down` deletes them:

```
docker compose cp server:/app/server/src/_secondary/image/generated/Character ./portrait-rescue
docker run --rm -v evejs-data:/data -v "${PWD}/portrait-rescue:/src" alpine sh -c "mkdir -p /data/gameStore/images/Character && cp -a /src/. /data/gameStore/images/Character/ && chown -R 1000:1000 /data/gameStore/images"
```

If that first command reports no such file or directory, the old containers had no uploaded portraits and there is nothing to rescue.

Now stop everything cleanly, still in the old install folder:

```
docker compose down
```

> **Never add `--volumes` when upgrading.** `docker compose down --volumes` deletes the `evejs-data` volume and with it every account, character, and market order.

Then unpack the new version — a new folder is fine — and start it:

```
docker compose build
docker compose up -d
```

Check that your characters are there before deleting the old folder.

### Upgrading a native Windows install

1. Close the server window and the market server window.
2. Unpack the new version into a **new folder** next to the old one.
3. Copy these from the old folder into the same locations in the new folder:
   - `_local\gameStore\`
   - `externalservices\market-server\data\generated\`
   - `evejs.config.local.json`
   - `server\src\_secondary\image\generated\Character\` — only if the old version has this folder (see the note above). `StartServer.bat` moves its contents into `_local\gameStore\images` on the next start.
4. Run `StartMarketServer.bat`, then `StartServer.bat`, in the new folder.

Keep the old folder until you have logged in and confirmed your characters, ships, and portraits are all present.

To move portraits by hand at any time, run this from the `server` folder:

```powershell
npm run images:migrate
```

Add `-- --dry-run` to see what it would move without changing anything.

### Moving a server to another PC

**Docker.** Stop the server with `docker compose down`, then pack the volume into a file:

```
docker run --rm -v evejs-data:/data -v "${PWD}:/backup" alpine tar czf /backup/evejs-data.tar.gz -C /data .
```

Copy `evejs-data.tar.gz` to the new PC, install the same EVE.js version there, and unpack it before the first start:

```
docker run --rm -v evejs-data:/data -v "${PWD}:/backup" alpine sh -c "cd /data && tar xzf /backup/evejs-data.tar.gz && chown -R 1000:1000 /data"
```

The same two commands make a complete backup and restore on one PC.

**Native Windows.** Copy the whole install folder to the new PC, then rerun the client setup wizard there so the new machine trusts the local certificates.

## Troubleshooting

- `docker compose ps` — check container and health status.
- `docker compose logs --tail 200 init market server` — inspect recent startup failures.
- `curl.exe http://127.0.0.1:26002/health` — check the Node HTTP side.
- `curl.exe http://127.0.0.1:40110/health` — check the Rust market.
- If Docker cannot publish port `443`, stop the other local program using it before starting EVE.js.
- If the market database is missing, run `docker compose run --rm --no-deps market-tools status`, then choose an explicit v1 or v2 rebuild command above.
- If a rebuild says the market is in use, run `docker compose stop server market` and retry it.
- If the client rejects local TLS, rerun the client setup wizard while the Docker backend is healthy so it installs the persisted Docker CA.

## More documentation

- [Detailed native setup](doc/SETUP.md)
- [Frontier Windows setup](doc/FRONTIER_WINDOWS_SETUP.md)
- [Launcher guide](doc/LAUNCHERS.md)
- [Market setup](doc/MARKET_SETUP.md)
- [Market seeder guide](doc/MARKET_SEEDER.md)
- [Troubleshooting](doc/TROUBLESHOOTING.md)
- [Tools and admin basics](doc/TOOLS.md)
- [Non-Docker setup audit and improvement report](doc/NON_DOCKER_SETUP_AUDIT.md)

Lots works; lots does not.
