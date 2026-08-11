# EVE Frontier Compatibility: Milestone Three

Milestone three advances the isolated Frontier profile from a stable character
selection screen to a small, persistent gameplay environment. The goal remains
compatibility research: use authority extracted from the installed client,
implement only observed contracts, and keep the retail client and normal EveJS
runtime untouched.

## Current Baseline

- Client version: `20.04`, cycle 6, MachoNet `489`
- Current development build: `3465410`
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
- rendered ballpark bootstrap, undock, manual pitch and yaw, derived Creation
  propulsion, native warp flight, and system transitions;
- modular Creation fitting, online/offline and effect state, fuel loading,
  capacitor use, action-bar abilities, transponders, beacons, and directional
  scanning contracts;
- station docking plus physical Refuge berthing and safe exterior undock;
- Network Node, Refuge, Heavy Gate, and Smart Storage deployment lifecycles;
- reciprocal Heavy Gate links and authenticated public traversal through valid,
  online gate pairs;
- prepared and replay-safe Smart Storage deposits and withdrawals with
  per-character partitions and persistent inventory state;
- local system view, map rows, ship skins, XMPP chat, experience response
  shapes, and secure local public-gateway services;
- client-authored landscapes, dungeon geometry, Rift scenes, and deterministic
  site commands without inventing missing server-side spawn tables.

## Client Staging

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
6. adds the EveJS CA to both embedded certificate bundles;
7. refreshes the affected manifest hashes and ad-hoc signs nested binaries;
8. records a stage marker and a timestamped backup of every changed file.

The patcher refuses unknown builds, unexpected bytes, partial patches,
unrecognized bytecode, or mismatched manifest state. It never modifies the
retail app.

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

## Known Limits

- Smart Storage validates the local compatibility transaction envelope but
  does not yet bind canonical BCS data to an authoritative Sui wallet identity.
- Heavy Gate traversal validates reciprocal online endpoints and system state,
  but physical proximity remains client-enforced.
- Assembly energy responses are wire-compatible but currently empty.
- Experience and progression responses are shaped bootstrap data with zero
  progression values.
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
