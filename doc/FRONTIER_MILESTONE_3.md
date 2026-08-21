# EVE Frontier Compatibility: Milestone Three

Milestone three advances the isolated Frontier profile from a stable character
selection screen to a small, persistent gameplay environment. The goal remains
compatibility research: use authority extracted from the installed client,
implement only observed contracts, and keep the retail client and normal EveJS
runtime untouched.

## Baselines

- Client version: `20.04`, cycle 6, MachoNet `489`
- Last live-accepted macOS build: `3467658`
- Windows candidate with exact profiles: `3474408`
- Game endpoint: `127.0.0.1:26000`
- Secure local public gateway: `127.0.0.1:26103`
- XMPP endpoint: `127.0.0.1:5222`
- Boot crypto: `Placebo`

Every client build is treated as a separate compatibility target. Static data,
generated databases, runtimes, client stages, binary hashes, docking bytecode
fingerprints, certificates, and logs remain build-numbered or host-local and
are not committed.

## Implemented Surface

The current profile includes:

- Python 3 MachoNet framing, marshal dialect, handshake, session, character
  creation, character selection, and returning-character login;
- Frontier `CreateCharacterInSpace` provisioning a modular Creation hull with
  canonical hidden modules and rollback-safe initialization;
- rendered ballpark bootstrap, undock, manual pitch, yaw, and strafe, derived
  Creation propulsion, native warp flight, and system transitions;
- modular Creation fitting, online/offline and effect state, fuel loading,
  capacitor use, action-bar abilities, transponders, beacons, and directional
  scanning contracts;
- station docking plus physical Refuge berthing and safe exterior undock;
- Network Node, Refuge, Heavy Gate, and Smart Storage deployment lifecycles;
- reciprocal Heavy Gate links and authenticated public traversal through valid,
  online gate pairs;
- prepared and replay-safe Smart Storage deposits and withdrawals with
  per-character partitions and persistent inventory state;
- safe-logoff eligibility, revalidated countdown, exact-position persistence,
  and canonical character-session cleanup;
- local system view, route/search panels, live IFF Cairn markers, map rows,
  ship skins, XMPP chat, module-less directional scanning, bounded shell and
  experience response shapes, and secure local public-gateway services;
- client-authored landscapes, dungeon geometry, Rift scenes, and deterministic
  site commands without inventing missing server-side spawn tables.

## macOS Client Staging

`StageFrontierClient.sh` copies the installed app into:

```text
~/Library/Application Support/evejs-frontier/macos/staged-client/<build>
```

The staging workflow:

1. verifies the exact installed build;
2. links only the retail `SharedCache/ResFiles` tree;
3. writes a staged `common.ini` with `cryptoPack = Placebo`;
4. patches the exact supported `blue.so` verifier instructions;
5. enables station docking in the staged `code.ccp` archive;
6. enables only the exact-build Frontier UI gates backed by tested server
   contracts;
7. adds the EveJS CA to both embedded certificate bundles;
8. refreshes the affected manifest hashes and ad-hoc signs nested binaries;
9. records a stage marker and a timestamped backup of every changed file.

The patcher refuses unknown builds, unexpected bytes, partial patches,
unrecognized bytecode, or mismatched manifest state. It never modifies the
retail app.

## Windows Client Staging Candidate

Build `3474408` adds a separate native Windows workflow. It does not reuse the
conventional EVE Online build-`3396210` wizard and does not alter the macOS
scripts above. The Windows client renamed its native module to
`bin64\blue.pyd`; both `manifest.dat` and the exported Python symbol confirm
that this is the build's native blue module rather than a missing `blue.dll`.

`StageFrontierClient.ps1` copies the build into:

```text
%LOCALAPPDATA%\EveJS-Frontier\windows\staged-client\<build>
```

Its marker-owned workflow hashes the official client before and after staging,
copies every non-resource build file, writes Placebo configuration, and either
creates a documented junction to the official shared `ResFiles` cache or makes
a complete resource copy. The transaction creates a timestamped in-stage
backup before changing `blue.pyd`, `code.ccp`, both CA bundles,
`manifest.dat`, or marker state.

The `blue-pyd.3474408.patch.json` profile proves an AMD64 PE32+ verifier path
and one exact normalization change at file offset `0x00196846`. The full signed
source hash is
`86f543d962e7531d1b47decc10498731927d32d28478fbc325d77807f67fc397`;
the deterministic target hash after exact certificate-overlay removal and PE
checksum recalculation is
`2dcfd00d4b84534abecf7f4cb3be09209fb2bac85377066cb8e18fe32131de82`.
Partial and unknown states fail.

The exact docking, beta, and shell bytecode fingerprints also changed from
`3467658` and were re-derived rather than allowlisted. The new shell constant
is spelled `HIDE_SHELL_RAIMENT_SYSTEM` and already ships `False`; the candidate
profile changes only the implant guard there, plus the same six tested beta
guards and the docking assignment. No blanket beta-disable behavior was added.

The PowerShell `-Check` path independently validates the stage, backups,
official hashes, manifest digests/trailer, certificates, `ResFiles`, Placebo
configuration, exact code states, exact `blue.pyd` target, and the untouched
signed `exefile.exe`.

## Reproduction

The complete extraction, server, staging, and launch sequence is documented in
the [Frontier macOS quickstart](../README.md#frontier-macos-quickstart). Run:

```bash
npm run test:frontier-static
npm run test:frontier-server
bash -n StartFrontierServer.sh StageFrontierClient.sh PlayFrontier.sh CaptureFrontierSession.sh
git diff --check
```

Automated tests are a compatibility gate, not proof of client-visible success.
Each supported build still requires a live login, rendered-space, flight, warp,
map, fitting, storage, docking, and gate-travel smoke test.

The Windows candidate uses PowerShell 7 commands documented in
[Frontier Windows setup](FRONTIER_WINDOWS_SETUP.md). Its automated gate also
includes:

```powershell
npm run test:frontier-windows
npm run test:frontier-static
npm run test:frontier-server -- --build 3474408
```

PowerShell parser checks, Python compilation/tests, Node syntax checks, listener
inspection, and `git diff --check` remain part of the final acceptance run.

## Build 3465410 Validation

The initial `3465410` update completed the following checks on macOS:

- `19/19` static-data tests and `154/154` Frontier server tests passed;
- the staged trust check confirmed the exact `blue.so` and docking patches,
  both CA bundles, five refreshed manifest entries, and valid nested signatures;
- the untouched retail `blue.so`, `code.ccp`, and `manifest.dat` retained their
  recorded source hashes after staging;
- a live client completed the handshake, selected the returning character,
  restored its Creation in system `30000004`, hydrated inventory and Destiny,
  and connected to the secure public gateway and XMPP service;
- no manifest, decrypt, certificate, or unhandled-service error appeared during
  that smoke run.

The broader fitting, storage, docking, and Heavy Gate interactions remain
covered by automation and prior-build live acceptance; they should be repeated
interactively before declaring full `3465410` gameplay parity.

## Build 3467658 Validation

The `3467658` update retained Frontier `20.04`, cycle 6, MachoNet `489`, the
existing public protobuf contracts, and the same client-module surface. The
macOS update completed the following checks:

- the installed static snapshot validated with 24,026 systems, 113,253
  landscape sites, 32,608 types, and 7,072 stargates;
- `19/19` static-data tests and `187/187` Frontier server tests passed against
  an isolated clone of the migrated `3467658` runtime;
- the complete mutable SQLite world was migrated from `3463382` with matching
  logical database hashes, while the old runtime remained intact;
- the staged trust check confirmed the exact-build `blue.so`, docking, and
  selected Frontier feature patches, both CA bundles, refreshed manifest
  entries, Placebo configuration, and valid nested signatures;
- the untouched retail `blue.so`, `code.ccp`, and `manifest.dat` retained their
  recorded source hashes after staging;
- a session-free client completed the `3467658` handshake, restored the
  returning Creation in space, hydrated inventory, and connected to the game,
  secure public-gateway, and XMPP endpoints;
- no manifest, decrypt, certificate-chain, or unhandled-service error appeared
  during the smoke run.

One extracted localization row currently resolves dungeon `12535` to the raw
message identifier `20002278` rather than `Accelerator Facility`. This is a
client-data quality difference, not a protocol or startup blocker.

## Build 3474408 Windows Candidate Evidence

Build `3474408` retains Frontier `20.04`, cycle 6, MachoNet `489`, and birthday
`170472`. The evidence derived from the untouched installed Windows client and
current build-numbered outputs is:

- `start.ini` reports build/sync `3474408`, branch `//frontier/cycle-6`, region
  `ccp`, and app name `FRONTIER`;
- MachoNet and GPS bytecode independently retain MachoNet `489` and birthday
  `170472`;
- external CPython 3.12 successfully imported the client types loader and
  protobuf modules with client-rooted Python and DLL paths, so MSVC was not
  required for this machine's extraction;
- the static snapshot validated with 24,026 systems, 113,253 landscape sites,
  32,623 types, and 7,072 stargates—15 more types than the `3467658` recorded
  count and no change to the other three counts;
- contract export produced 163 descriptor files with no failures and 239
  client modules;
- exact source and patched hashes were derived for `blue.pyd`, station docking,
  the six selected beta guards, and the one implant shell guard;
- the official `exefile.exe` and `blue.pyd` initially had valid Authenticode,
  and the PE certificate table was proven to be a single overlay ending at
  EOF;
- the strict manifest parser identified the actual five digest targets,
  including `root:/bin64\blue.pyd`, while retaining the version-4 trailer;
- the official `blue.pyd` and `code.ccp` hashes were rechecked after analysis
  on temporary copies without a detected source change.

The build-`3467658` descriptor set, client-module inventory, and JSONL snapshot
are not present in this checkout. Therefore byte-for-byte contract equivalence
and the identities of the 15 new type rows remain unproven from the available
baseline. Static comparison alone did not identify a changed server contract.
The subsequent live run did expose the corrected `shellManager.has_raiment`
spelling, the `statusEffectMgr.get_effect_config` mapping surface, and a latent
ship-activation clock reference. Their accepted shapes and neutral fallbacks
were derived from the exact installed bytecode, implemented without claiming
to reproduce an unknown CCP production payload, and covered by focused tests.

The completed Windows evidence now also includes:

- a build-numbered stage at
  `%LOCALAPPDATA%\EveJS-Frontier\windows\staged-client\3474408`, with a verified
  junction to the discovered official `ResFiles` cache;
- a green independent staged `-Check`, including exact patched `blue.pyd` and
  `code.ccp`, both one-copy CA bundles and certificate chains, the five actual
  manifest targets and unchanged trailer, the complete backup, Placebo boot,
  signed untouched `exefile.exe`, and official-source preservation;
- a retained transaction backup at
  `<stage>\.evejs-backups\frontier-client-20260821-135648`;
- complete validation suites: PowerShell parser 16/16, Python compilation
  12/12 and units 15/15, Node syntax 1,028/1,028, static 28/28, build-specific
  server 216/216, Windows Node 14/14 plus Python 15/15, runners 6/6,
  isolated-helper 2/2, and `git diff --check`;
- all six live listeners bound only to `127.0.0.1`;
- a LogLite-assisted session-free client handshake with build `3474408`,
  birthday `170472`, MachoNet `489`, version `20.04`, and project
  `cycle-6@ccp`, followed by login, character creation/selection, rendered
  station and space, undock, station docking, XMPP, and TLS/H2 public-gateway
  streams; and
- a post-run official-client re-hash matching every recorded pre-stage value.

The live session did not complete movement/warp, Creation fitting and
reload/unload, Smart Storage, Heavy Gate traversal, or the full HUD/map call
surface. The service fixes discovered during that run also require a client
recheck. Build `3474408` therefore remains a Windows candidate rather than a
claim of complete live gameplay support.

## Known Limits

- Smart Storage validates the local compatibility transaction envelope but
  does not yet bind canonical BCS data to an authoritative Sui wallet identity.
- Heavy Gate traversal validates reciprocal online endpoints and system state,
  but physical proximity remains client-enforced.
- Assembly energy responses are wire-compatible but currently empty.
- Experience and progression responses are shaped bootstrap data with zero
  progression values; unsupported crown, implant, reignment, and ascension
  mutations fail explicitly rather than inventing rules.
- The HUD system-information response is exact-shaped but remains empty until
  danger tiers, remnant composition, substrate weights, and locator-potential
  inputs are extracted from an authoritative client source.
- Industry production, the market, Relay Lens, token mutation, storage-to-
  storage transfer, and several career or mission surfaces remain incomplete.
- Rift scenes render, but full discovery, harvesting, depletion, and respawn
  are not yet a complete gameplay loop.
- Large Dogma, brain, and skill hydration packets remain an optimization target.

## Next Boundary

The next milestone should turn one authored activity into a complete persistent
loop, rather than adding broad placeholder services. Rift resource extraction
is the strongest candidate: discover a site, warp to it, activate an authored
extractor contract, receive cargo, persist depletion, and safely respawn it.
