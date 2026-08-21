# Troubleshooting

This is the calm "something is being annoying" guide. Use the Frontier section
only for `SetupFrontierWindows.ps1` and the conventional EVE Online section for
the build-`3396210` batch files.

## EVE Frontier on Windows

Start with read-only checks:

```powershell
.\SetupFrontierWindows.ps1 -Status
.\StageFrontierClient.ps1 -Build 3474408 -Status
$stage = "$env:LOCALAPPDATA\EveJS-Frontier\windows\staged-client\3474408"
.\PatchFrontierClientTrust.ps1 -StagedRoot $stage -Check
.\StartFrontierServer.ps1 -Build 3474408 -Status
```

### The client cannot be discovered

Pass the real channel/build directory explicitly:

```powershell
npm run frontier:discover -- --client-root 'C:\CCP\EVE Frontier\stillness' --build 3474408
```

A valid root needs `appname=FRONTIER` in `start.ini`, a numeric build,
`bin64\exefile.exe`, one native `blue.pyd`/`blue.dll`, `code.ccp`,
`manifest.dat`, `resfileindex.txt`, `bin64\staticdata\mapObjects.db`, and a
resolvable sibling/shared `ResFiles` tree. Discovery refuses an ambiguous
highest build. Do not solve this by pointing the EVE Online `tq` wizard at the
Frontier cache.

### The build or native blue file is unsupported

This is a safe failure. Build `3474408` requires the exact source
`bin64\blue.pyd` SHA-256
`86f543d962e7531d1b47decc10498731927d32d28478fbc325d77807f67fc397`
or the exact target SHA-256
`2dcfd00d4b84534abecf7f4cb3be09209fb2bac85377066cb8e18fe32131de82`.
Anything else—including a partial patch—must be analyzed as a new build. Do
not copy an older `blue.so` profile, use the EVE Online build-`3396210`
`blue.dll` recipe, edit the expected hash, or add an “attempt anyway” path.

### Defender reports the staged `blue.pyd`

The exact content patch intentionally invalidates `blue.pyd`'s original
Authenticode signature. The patcher verifies and removes only the proven PE
certificate overlay and recalculates the PE checksum. `bin64\exefile.exe`
remains byte-for-byte retail and `-Check` requires its Authenticode status to
be `Valid`.

Review the alert's exact path and hashes. The expected changed file is inside
the build-numbered `%LOCALAPPDATA%\EveJS-Frontier\windows\staged-client`
directory, never `C:\CCP\EVE Frontier` or another official launcher cache. Do
not make a broad Defender exclusion. If Defender quarantined the staged file,
remove and recreate only the recognized stage after reviewing the marker and
alert; leave the official client untouched.

### Python 3.12 or native FSD imports fail

Install CPython 3.12 x64 exactly and open a fresh PowerShell 7:

```powershell
winget install --exact --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
py -3.12 -c "import platform,sys; print(sys.version); print(platform.architecture())"
```

Python 3.13 or newer is not a substitute. Rerun setup to recreate
`_local\frontier-python312` and install the pinned requirements. The extractor
first probes this interpreter with the client's `code.ccp` and `bin64`. Visual
Studio 2022 Build Tools with the C++ workload and Windows SDK is needed only if
that probe fails and the `python312.dll` runner must be compiled. Capture the
probe error before installing the compiler fallback.

### `better-sqlite3` reports a Node ABI error

Confirm Node.js 24 LTS x64, then reinstall server dependencies under that exact
Node executable:

```powershell
node --version
npm --prefix server ci
node -e "const D=require('./server/node_modules/better-sqlite3');const d=new D(':memory:');console.log(d.prepare('select sqlite_version() v').get().v);d.close()"
```

Opening an in-memory database must succeed before server startup.

### Certificate or secure-gateway checks fail

Run the patch wrapper without `-Check` to generate/reuse the EveJS CA and leaf
certificates and re-run the exact stage transaction:

```powershell
.\PatchFrontierClientTrust.ps1 -StagedRoot $stage
.\PatchFrontierClientTrust.ps1 -StagedRoot $stage -Check
```

Only the public CA belongs in `Cert:\CurrentUser\Root`. Private keys remain in
the ignored server certificate paths and must have an ACL restricted to the
current SID. Both staged CA bundles must contain the public CA exactly once,
and the XMPP and gateway leaves must chain to it. Never recursively append a
certificate to the official client.

### Manifest validation fails

Do not hand-edit `manifest.dat`. The checker requires version 4, unique and
safe paths, the exact five real targets for this build, valid digest spans, and
an unchanged trailer. A missing, duplicate, aliased, escaped, or unknown target
is evidence that the client/profile changed. Recreate the isolated stage from
the exact official source; if it fails again, preserve the stage and report the
manifest evidence.

### The `ResFiles` check fails

The default stage entry must be a junction whose resolved target matches the
official shared cache recorded by the marker. It is shared, not read-only. If
the launcher moved its cache, review the new official client and recreate the
stage. For a self-contained stage, run setup or staging with `-CopyResFiles`;
allow enough disk space and time for the complete cache.

### A required port is already in use

The Frontier ports are `26000`, `26101`, `26102`, `26103`, `5222`, and `26401`.
Inspect ownership before stopping anything:

```powershell
$ports = 26000,26101,26102,26103,5222,26401
Get-NetTCPConnection -State Listen |
    Where-Object LocalPort -In $ports |
    Format-Table LocalAddress,LocalPort,OwningProcess
```

All EveJS Frontier listeners must show `127.0.0.1`. Do not change them to
`0.0.0.0`, forward them, or broadly terminate Node processes.

### Runtime reset or upgrade is refused

The server only creates, reuses, or resets an exact marker-owned path under
`_local\frontier-runtime\<build>`. Stop a recorded background server before a
deliberate reset. Cross-build migration is not automatic: use a consistent
SQLite online backup, initialize the new build from its new static data,
restore only mutable SQLite state and runtime images, and leave the old runtime
intact. Never migrate by copying live `-wal` or `-shm` files.

### The staged client starts but compatibility is unclear

Start EVE LogLite from EVE Launcher → cogwheel → Tools → Start LogLite. Check:

```text
%LOCALAPPDATA%\EveJS-Frontier\windows\logs\3474408\logs-client.jsonl
server\logs\server.log
_local\frontier-runtime\3474408\server.stdout.log
_local\frontier-runtime\3474408\server.stderr.log
```

Look for manifest, decrypt, certificate-chain, handshake, unknown-build, and
unhandled-service errors. A successful process start is not acceptance: build
`3474408` has completed handshake, login, rendered-space, docking, XMPP, and
secure-gateway smoke coverage, but still requires the remaining live gameplay
matrix described in [FRONTIER_WINDOWS_SETUP.md](FRONTIER_WINDOWS_SETUP.md).

## Conventional EVE Online build 3396210

### Start Here First

Check these before doing anything fancy:

1. Did you install Node.js `LTS`?
2. Did you run `npm ci` and `npm --prefix server ci` from the repo root?
3. Did `tools\ClientSETUP\StartClientSetup.bat` finish all of its steps?
4. Are you using a copied EVE client folder?
5. Did the local database finish generating under `_local\gameStore`?
6. Is `StartServer.bat` running before the game tries to connect?

### Problem: The Setup Wizard Cannot Find My Game

Usually this means one of these happened:

- you picked the wrong folder
- you picked your live EVE install instead of a copied one
- you picked a launcher folder instead of the actual copied client folder

Best fix:

1. run `tools\ClientSETUP\StartClientSetup.bat` again
2. point it at your copied EVE folder
3. let it finish the checks again

### Problem: Play.bat Says Setup Is Still Needed

This usually means one of the required setup pieces is still missing.

Best fix:

1. run `tools\ClientSETUP\StartClientSetup.bat` again
2. let it complete every step
3. try `Play.bat` again

### Problem: The Game Opens But Will Not Log In

Check these:

1. is `StartServer.bat` still open?
2. did you start the server before launching the client?
3. did the setup wizard finish the certificate and patching steps?
4. did the local database generation finish successfully?

The easiest retry path is:

1. close the client
2. start `StartServer.bat`
3. choose `2`

### Problem: Database Generation Failed

`StartServer.bat` runs `tools\DatabaseCreator\CreateDatabase.bat` automatically when `_local\gameStore\manifest.json` is missing.

Check these:

1. Node.js `LTS` is installed and available in Terminal
2. your internet connection can download the public EVE SDE
3. the repo path is not read-only
4. there is enough free disk space for the SDE download and generated database

To retry from scratch, run:

```text
tools\DatabaseCreator\CreateDatabase.bat /force
```

### Problem: Windows Blocked A Setup Step

Try this:

1. close the wizard
2. right-click `tools\ClientSETUP\StartClientSetup.bat`
3. choose `Run as administrator`
4. run the setup again

This is most often needed for certificate-related or patch-related steps.

### Problem: The Optional Market Looks Empty

Check these in order:

1. did `BuildMarketSeed.bat` finish successfully?
2. is `StartMarketServer.bat` running?
3. did you reseed and forget to restart the market server?

If in doubt:

1. run `BuildMarketSeed.bat`
2. choose `Jita + New Caldari`
3. start `StartMarketServer.bat` again

### Problem: The Config Editor Will Not Open

Try:

1. run `tools\ConfigEditor\OpenServerConfig.bat` again
2. allow PowerShell if Windows prompts you

If it still closes instantly, keep the error window open and read the first error line.

### Problem: The Store Editor Will Not Open

`tools\NewEdenStoreEditor\StartStoreEditor.bat` needs Python 3.

If it says Python is missing:

1. install Python 3
2. run the same launcher again

### The Fast Recovery Path

If you just want to get back in quickly:

1. close the client
2. run `tools\ClientSETUP\StartClientSetup.bat`
3. run `StartServer.bat`
4. choose `2`

## More Guides

- [SETUP.md](SETUP.md)
- [FRONTIER_WINDOWS_SETUP.md](FRONTIER_WINDOWS_SETUP.md)
- [LAUNCHERS.md](LAUNCHERS.md)
- [MARKET_SETUP.md](MARKET_SETUP.md)
- [TOOLS.md](TOOLS.md)
