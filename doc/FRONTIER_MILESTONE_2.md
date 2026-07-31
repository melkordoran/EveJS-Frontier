# EVE Frontier Compatibility: Milestone Two

Milestone two carries the isolated EVE Frontier build `3450341` session from
the authenticated MachoNet handshake through character creation and character
selection. It builds on the reproducible client/static-data baseline described
in `FRONTIER_MILESTONE_1.md`.

## Isolation

The work remains confined to:

- Repository: `/Users/phillip/EVE/EveJS-Frontier`
- Generated runtime: `_local/frontier-runtime/3450341`
- Generated static data: `_local/frontier-sde/3450341`
- Generated game database: `_local/frontier-gameStore/3450341/data`
- Staged client:
  `~/Library/Application Support/evejs-frontier/macos/staged-client/3450341`
- Game TCP endpoint: `127.0.0.1:26000`

The normal EveJS checkout, normal EveJS runtime, retail Frontier app, and retail
client resources were not modified. Generated client data and local runtime
state remain ignored by Git.

## Protocol Compatibility

The Frontier profile now:

- encodes named MachoNet packet and address objects as Python 3 `ObjectEx2`
- accepts inbound `ObjectEx1` and `ObjectEx2` wrappers
- preserves legacy `PyObject` encoding for the Tranquility profile
- writes arbitrary Frontier binary payloads with the Python 3 bytes opcode
  instead of the legacy text-decoded buffer opcode
- returns a starter-group graph rooted at the first valid Frontier station
- accepts `CreateCharacterInSpace(name, starterGroupID)`
- routes Frontier creation through the existing transactional character,
  wallet, item, and starter-ship creation path
- applies the selected character and sends the full session change

The binary-payload distinction is required for broadcast notifications.
Encoding an inner notification stream with the legacy buffer opcode caused the
Frontier client to decode arbitrary bytes as UTF-8 and disconnect on dogma
attribute values.

## Live Result

A live run of the staged client and isolated server completed:

1. Placebo authentication and session initialization.
2. `GetCharacterSelectionData`.
3. `GetStarterGroups`.
4. `CreateCharacterInSpace("Kyrvan", 1)`.
5. Persistent character and starter-ship creation.
6. `SelectCharacterID(140000005)`.
7. Dogma binding and binary notification processing.
8. Initial docked UI startup without a transport disconnect.

The isolated runtime now contains:

- Character: `Kyrvan` (`140000005`)
- Starter ship: `Wend` (`9988400000487`, type `87698`)
- Station: `64000001`
- Solar system: `UR7-5FN` (`30000004`)

The client displayed the docked UI, active ship, local chat, and Undock control.

## Verification

Run:

```bash
npm run test:frontier-static
npm run test:frontier-server
bash -n StartFrontierServer.sh StageFrontierClient.sh PlayFrontier.sh CaptureFrontierSession.sh
git diff --check
```

The server profile tests cover the Frontier and Tranquility object encodings,
Frontier and legacy binary buffer opcodes, frame endianness, handshake values,
and inbound ObjectEx packet/address decoding.

## Next Boundary

The connection is stable past character selection, but the docked scene is not
yet a complete gameplay milestone. The next compatibility work is:

- return Frontier-compatible station metadata from `map.GetStationInfo`
- adapt the dogma `attributes` collection to Frontier's iterable pair shape
- remove Python 2 `__builtin__.set` references from bound-object payloads
- implement or intentionally stub Frontier's `creation.get_creation` and
  `berthingSvc.get_my_contract` calls

The current center station scene is black because station lookup does not yet
produce a usable client row. These failures are post-selection service
contracts; they no longer terminate the MachoNet transport.

Warnings about the optional market daemon and local chat listener remain
non-blocking for this milestone.
