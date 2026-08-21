# Launcher Guide

This is the "what should I click?" page. First decide whether you are running
EVE Frontier or conventional EVE Online; their launchers and client patches
are intentionally separate.

## EVE Frontier on Windows (build 3474408 candidate)

Use these PowerShell 7 launchers only for the exact Frontier workflow:

| Run this | Use it when | What it does |
|---|---|---|
| `SetupFrontierWindows.bat` or `SetupFrontierWindows.ps1` | First setup or a build refresh | Installs/reports prerequisites, prepares build-numbered data and contracts, and stages the discovered Frontier client |
| `StageFrontierClient.bat` or `StageFrontierClient.ps1` | You need to recreate only the isolated client stage | Copies the build, creates a `ResFiles` junction by default (or copies it with `-CopyResFiles`), and runs the exact patch transaction |
| `PatchFrontierClientTrust.ps1` | You need to patch or independently check one stage | Applies only exact-build profiles; `-Check` is required before launch and does not mutate |
| `StartFrontierServer.ps1` | Daily Frontier server use | Initializes/reuses the build-numbered runtime and starts only loopback listeners; the market stays disabled |
| `PlayFrontier.ps1` | Daily Frontier client use | Runs staged `-Check`, then launches only the staged `exefile.exe` with the local Frontier environment |
| `CaptureFrontierSession.ps1` | Session-free launch proved insufficient | Captures one official launcher process without displaying credentials and restricts the ignored session file to the current SID |
| `StopFrontier.ps1` | Stop a server started with `-Background` | Verifies the recorded process identity and stops only that PID |

The normal order is:

```powershell
.\SetupFrontierWindows.ps1 -Status
.\SetupFrontierWindows.ps1 -SourceRoot 'C:\CCP\EVE Frontier\stillness'
.\StartFrontierServer.ps1 -Build 3474408
# In another PowerShell:
.\PlayFrontier.ps1 -Build 3474408
```

Status and preview commands do not start the client:

```powershell
.\SetupFrontierWindows.ps1 -Status
.\StageFrontierClient.ps1 -Build 3474408 -DryRun
.\PatchFrontierClientTrust.ps1 -StagedRoot "$env:LOCALAPPDATA\EveJS-Frontier\windows\staged-client\3474408" -Check
.\StartFrontierServer.ps1 -Build 3474408 -Status
.\StopFrontier.ps1 -Build 3474408 -DryRun
```

Windows build `3474408` uses `blue.pyd`, not `blue.dll`. Its LogLite-assisted
session-free smoke reached the local server, login, rendered space, docking,
XMPP, and the secure gateway. The full flight/warp and Frontier feature matrix
is still pending; see [FRONTIER_WINDOWS_SETUP.md](FRONTIER_WINDOWS_SETUP.md)
before treating it as a fully supported target.

## Conventional EVE Online build 3396210

If you do not want to guess which batch file matters, use this.

### The Only Two Buttons Most People Need

* `SetupEveJS.bat`
* `StartServer.bat`

That is enough for normal setup and play.

### What Each Launcher Does

|Click this|Use it when|What it does|
|-|-|-|
|`SetupEveJS.bat`|First-time setup, or after an update|Runs every setup step in the right order and skips whatever is already done. `-Status` shows progress without changing anything|
|`tools\\\\\\\\ClientSETUP\\\\\\\\StartClientSetup.bat`|You only want to redo the client|Walks you through client setup, certificate install, patching, and local-server config|
|`StartServer.bat`|Normal daily use|Creates the local database if needed, then starts the server or starts the server and launches the client for you|
|`Play.bat`|You already started the server yourself|Launches only the client|
|`tools\DatabaseCreator\CreateDatabase.bat`|You want to create or rebuild local database files manually|Downloads the public EVE SDE and generates `_local\gameStore`|
|`BuildMarketSeed.bat`|You want the optional standalone market|Builds or refreshes the market database|
|`StartMarketServer.bat`|You use the optional standalone market|Starts the separate market daemon|
|`tools\\\\\\\\ConfigEditor\\\\\\\\OpenServerConfig.bat`|You want to edit local config or player data|Creates the local database if needed, then opens the desktop config and database editor|
|`tools\\\\\\\\NewEdenStoreEditor\\\\\\\\StartStoreEditor.bat`|You want to edit store content|Opens the desktop New Eden Store editor|

### Best Choices By Situation

#### I am brand new

Click:

```text
SetupEveJS.bat
```

Then:

```text
StartServer.bat
```

Choose `2`.

The first server start may take longer because it downloads the SDE and generates `_local\gameStore`.

#### I already set everything up before

Click:

```text
StartServer.bat
```

Choose:

* `1` if you only want the server
* `2` if you want the server and client together

#### I already have the server running and only want to launch the game

Click:

```text
Play.bat
```

#### I want the optional fast market

Click these in order:

1. `BuildMarketSeed.bat`
2. `StartMarketServer.bat`
3. `StartServer.bat`

#### I want to edit server settings or data

Click:

```text
tools\\\\\\\\ConfigEditor\\\\\\\\OpenServerConfig.bat
```

The first launch may take longer because it generates `_local\gameStore` if the local database is missing.

#### I want to edit the store

Click:

```text
tools\\\\\\\\NewEdenStoreEditor\\\\\\\\StartStoreEditor.bat
```

That tool needs Python 3 installed.

### Launchers Most Players Can Ignore

You usually do not need to touch:

* `PlayDebug.bat`
* `tools\\\\\\\\ClientCodeGrabber\\\\\\\\StartCodeGrabber.bat`

You also usually do not need to run `tools\DatabaseCreator\CreateDatabase.bat` by hand. Use it when you want to rebuild the local database with `/force`.

Those are more useful for debugging or project maintenance than normal play.

## Related Guides

* [SETUP.md](SETUP.md)
* [FRONTIER_WINDOWS_SETUP.md](FRONTIER_WINDOWS_SETUP.md)
* [MARKET\_SETUP.md](MARKET_SETUP.md)
* [TOOLS.md](TOOLS.md)
* [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
