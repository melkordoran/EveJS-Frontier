# EVE Frontier Compatibility: Milestone One

This experimental fork establishes a reproducible, isolated baseline for
connecting the installed EVE Frontier client to EveJS. It uses static data
extracted from Phillip's locally installed client and does not copy proprietary
client data into Git.

Milestone one ends after authenticated MachoNet session creation. Character
selection is the next protocol boundary.

## Isolation

- Repository: `/Users/phillip/EVE/EveJS-Frontier`
- Upstream baseline: EveJS v0.12.3.1, tagged `upstream-v0.12.3.1`
- Frontier build: `3450341`
- Extracted static snapshot: `_local/frontier-sde/3450341`
- Generated game database: `_local/frontier-gameStore/3450341/data`
- Staged client:
  `~/Library/Application Support/evejs-frontier/macos/staged-client/3450341`
- Staged-client alias:
  `~/Library/Application Support/evejs-frontier/macos/staged-client/current`
- Client settings profile: `EveJSFrontier`
- Game TCP endpoint: `127.0.0.1:26000`

The staged app is a copied Frontier app with a read-only link to the installed
client's large `ResFiles` tree. The retail app, retail manifests, live EveJS
checkout, and existing EveJS client staging area are not modified.

Generated static data, databases, logs, captured launcher arguments, and local
certificates remain ignored by Git.

## Rebuild

From the repository root:

```bash
npm run frontier:extract -- --build 3450341
npm run frontier:database -- --snapshot _local/frontier-sde/3450341
npm run frontier:validate -- --snapshot _local/frontier-sde/3450341
bash StageFrontierClient.sh
```

Start the isolated server and, in a second terminal, the staged client:

```bash
./StartFrontierServer.sh
./PlayFrontier.sh
```

`PlayFrontier.sh` stays attached by default so client output and lifecycle
remain observable. Use `--detach` only when background launch behavior is
specifically needed.

## Static Baseline

The build `3450341` extraction contains:

- 26 JSONL outputs
- 1,025,821 records
- 223,735,338 bytes
- 24,026 solar systems
- 32,606 item types
- 7,072 reciprocal stargate records

The generated EveJS profile contains:

- 670,973 celestials
- 32,605 usable item types
- 103 stations
- 7,072 stargates
- 24,026 solar systems
- 4 seeded characters across 2 local test accounts

## Protocol Result

The Frontier compatibility profile now handles:

- build `3450341`, MachoNet version `489`, birthday `170472`
- release string `cycle-6@ccp`
- big-endian MachoNet frame lengths
- the Frontier Python 3 marshal text and bytes dialect used during login
- Placebo challenge hashing with CRC-HQX
- a no-op signed function represented as Python bytes
- `CryptoHandshakeResult` and `CryptoHandshakeAck`

A live staged-client run on `127.0.0.1:26000` completed authentication for
`Phillip`, completed the crypto handshake, and created the server session.

## Next Boundary

The first post-auth `SessionInitialStateNotification` currently fails in the
Frontier client with:

```text
Invalid type tag 23 in stream
```

Decimal tag `23` is the legacy marshal `PyObject` opcode (`0x17`). The Frontier
client no longer accepts that object representation for this packet. Milestone
two should identify and implement Frontier's Python 3 object/class packet
encoding, then carry the session through character selection.

Warnings about an unavailable market daemon are expected while running only
this handshake-focused server profile and do not block the verified login path.
