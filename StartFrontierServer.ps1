#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^\d+$')]
    [string]$Build = '3474408',

    [ValidatePattern('^\d+(?:\.\d+)*$')]
    [string]$ClientVersion = '20.04',

    [ValidateRange(1, 2147483647)]
    [int]$MachoVersion = 489,

    [ValidatePattern('^\d+$')]
    [string]$Birthday = '170472',

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Codename = 'cycle-6',

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Region = 'ccp',

    [ValidatePattern('^[A-Za-z0-9._@-]+$')]
    [string]$ProjectVersion = 'V20.04@ccp',

    [switch]$ResetRuntime,
    [switch]$Quiet,
    [switch]$Background,
    [switch]$InitializeOnly,
    [switch]$Status,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'StartFrontierServer.ps1 supports Windows only.'
}
if ($InitializeOnly -and $Background) {
    throw '-InitializeOnly and -Background cannot be used together.'
}

$script:RuntimeMarkerKind = 'evejs-frontier-runtime'
$script:RuntimeMarkerSchemaVersion = 1
$script:PidMarkerKind = 'evejs-frontier-server-process'
$script:PidMarkerSchemaVersion = 1
$script:PathComparison = [StringComparison]::OrdinalIgnoreCase

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$GeneratedRoot = [IO.Path]::GetFullPath(
    (Join-Path $RepoRoot (Join-Path '_local\frontier-gameStore' $Build))
)
$GeneratedData = Join-Path $GeneratedRoot 'data'
$GeneratedManifest = Join-Path $GeneratedRoot 'manifest.json'
$RuntimeBase = [IO.Path]::GetFullPath(
    (Join-Path $RepoRoot '_local\frontier-runtime')
)
$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeBase $Build))
$ExpectedRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeBase $Build))
$RuntimeData = Join-Path $RuntimeRoot 'gameStore\data'
$RuntimeMarker = Join-Path $RuntimeRoot '.evejs-frontier-runtime'
$PidMarker = Join-Path $RuntimeRoot '.evejs-frontier-server.pid.json'
$StaticRoot = [IO.Path]::GetFullPath(
    (Join-Path $RepoRoot (Join-Path '_local\frontier-sde' $Build))
)
$ServerEntry = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'server\index.js'))

function Test-SamePath {
    param(
        [Parameter(Mandatory)] [string]$Left,
        [Parameter(Mandatory)] [string]$Right
    )

    return [string]::Equals(
        [IO.Path]::GetFullPath($Left).TrimEnd('\', '/'),
        [IO.Path]::GetFullPath($Right).TrimEnd('\', '/'),
        $script:PathComparison
    )
}

function Assert-ContainedExactRuntimePath {
    if (-not (Test-SamePath -Left $RuntimeRoot -Right $ExpectedRuntimeRoot)) {
        throw "Runtime path does not exactly match the requested build: $RuntimeRoot"
    }

    $basePrefix = $RuntimeBase.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $RuntimeRoot.StartsWith($basePrefix, $script:PathComparison)) {
        throw "Runtime path escapes the known runtime base: $RuntimeRoot"
    }
    if ([IO.Path]::GetFileName($RuntimeRoot) -ne $Build) {
        throw "Runtime leaf does not match build ${Build}: $RuntimeRoot"
    }

    Assert-NoReparsePathChain -Path $RuntimeRoot -Purpose 'runtime access'
}

function Assert-NoReparsePathChain {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Purpose
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $resolvedRepo = $RepoRoot.TrimEnd('\', '/')
    $repoPrefix = $resolvedRepo + [IO.Path]::DirectorySeparatorChar
    if (-not [string]::Equals($resolvedPath, $resolvedRepo, $script:PathComparison) -and
        -not $resolvedPath.StartsWith($repoPrefix, $script:PathComparison)) {
        throw "Refusing $Purpose outside the repository: $resolvedPath"
    }

    $cursor = $resolvedPath
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing $Purpose through a reparse-point path component: $($item.FullName)"
            }
        }
        if ([string]::Equals($cursor, $resolvedRepo, $script:PathComparison)) {
            break
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $cursor, $script:PathComparison)) {
            throw "Could not prove repository containment for ${Purpose}: $resolvedPath"
        }
        $cursor = [IO.Path]::GetFullPath($parent).TrimEnd('\', '/')
    }
}

function Assert-NoReparseTree {
    param(
        [Parameter(Mandatory)] [string]$Root,
        [Parameter(Mandatory)] [string]$Purpose
    )

    if (-not (Test-Path -LiteralPath $Root)) {
        return
    }
    Assert-NoReparsePathChain -Path $Root -Purpose $Purpose
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing $Purpose through a reparse point: $($rootItem.FullName)"
    }

    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($rootItem.FullName)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing $Purpose with a nested reparse point: $($item.FullName)"
            }
            if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push($item.FullName)
            }
        }
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [object]$Value
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Marker parent is missing: $parent"
    }
    $temporary = Join-Path $parent (
        '.{0}.tmp-{1}-{2}' -f [IO.Path]::GetFileName($Path), $PID, [guid]::NewGuid().ToString('N')
    )
    $encoding = [Text.UTF8Encoding]::new($false)
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
            $encoding
        )
        [IO.File]::OpenRead($temporary).Dispose()
        Move-Item -LiteralPath $temporary -Destination $Path
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Assert-RequiredProperties {
    param(
        [Parameter(Mandatory)] [object]$Value,
        [Parameter(Mandatory)] [string[]]$Names,
        [Parameter(Mandatory)] [string]$Description
    )

    $present = @($Value.PSObject.Properties.Name)
    $missing = @($Names | Where-Object { $present -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw "$Description is missing required field(s): $($missing -join ', ')"
    }
}

function Read-RuntimeMarker {
    if (-not (Test-Path -LiteralPath $RuntimeMarker -PathType Leaf)) {
        throw "Refusing an unrecognized runtime without its marker: $RuntimeRoot"
    }

    $raw = Get-Content -LiteralPath $RuntimeMarker -Raw
    if ($raw.Trim() -eq "build=$Build") {
        return [pscustomobject]@{
            kind = $script:RuntimeMarkerKind
            schemaVersion = 0
            build = $Build
            runtimeRoot = $RuntimeRoot
            legacy = $true
        }
    }

    try {
        $marker = $raw | ConvertFrom-Json
    }
    catch {
        throw "Runtime marker is malformed: $RuntimeMarker"
    }
    Assert-RequiredProperties -Value $marker -Names @(
        'kind',
        'schemaVersion',
        'build',
        'runtimeRoot',
        'generatedRoot',
        'staticRoot'
    ) -Description 'Runtime marker'
    if ($marker.kind -ne $script:RuntimeMarkerKind -or
        [int]$marker.schemaVersion -ne $script:RuntimeMarkerSchemaVersion) {
        throw "Runtime marker format is unsupported: $RuntimeMarker"
    }
    if ([string]$marker.build -ne $Build) {
        throw "Runtime marker build does not match ${Build}: $($marker.build)"
    }
    if (-not (Test-SamePath -Left ([string]$marker.runtimeRoot) -Right $RuntimeRoot)) {
        throw "Runtime marker is owned by another path: $($marker.runtimeRoot)"
    }
    if (-not (Test-SamePath -Left ([string]$marker.generatedRoot) -Right $GeneratedRoot)) {
        throw "Runtime marker references another generated root: $($marker.generatedRoot)"
    }
    if (-not (Test-SamePath -Left ([string]$marker.staticRoot) -Right $StaticRoot)) {
        throw "Runtime marker references another static root: $($marker.staticRoot)"
    }
    return $marker
}

function Assert-RecognizedRuntime {
    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
        throw "Frontier runtime is missing: $RuntimeRoot"
    }
    Assert-ContainedExactRuntimePath
    Assert-NoReparseTree -Root $RuntimeRoot -Purpose 'runtime reuse'
    $marker = Read-RuntimeMarker
    if (-not (Test-Path -LiteralPath $RuntimeData -PathType Container)) {
        throw "Recognized runtime is incomplete; data is missing: $RuntimeData"
    }
    return $marker
}

function Read-PidMarker {
    if (-not (Test-Path -LiteralPath $PidMarker -PathType Leaf)) {
        return $null
    }
    try {
        $marker = Get-Content -LiteralPath $PidMarker -Raw | ConvertFrom-Json
    }
    catch {
        throw "Server PID marker is malformed: $PidMarker"
    }
    Assert-RequiredProperties -Value $marker -Names @(
        'kind',
        'schemaVersion',
        'build',
        'runtimeRoot',
        'pid',
        'processStartTimeUtcTicks',
        'nodePath',
        'serverEntry'
    ) -Description 'Server PID marker'
    if ($marker.kind -ne $script:PidMarkerKind -or
        [int]$marker.schemaVersion -ne $script:PidMarkerSchemaVersion) {
        throw "Server PID marker format is unsupported: $PidMarker"
    }
    if ([string]$marker.build -ne $Build -or
        -not (Test-SamePath -Left ([string]$marker.runtimeRoot) -Right $RuntimeRoot)) {
        throw "Server PID marker is not owned by build ${Build}: $PidMarker"
    }
    if (-not (Test-SamePath -Left ([string]$marker.serverEntry) -Right $ServerEntry)) {
        throw "Server PID marker references another entry point: $($marker.serverEntry)"
    }
    if ([int64]$marker.pid -le 0 -or [int64]$marker.processStartTimeUtcTicks -le 0) {
        throw "Server PID marker contains an invalid process identity: $PidMarker"
    }
    return $marker
}

function Get-OwnedProcessState {
    $marker = Read-PidMarker
    if ($null -eq $marker) {
        return [pscustomobject]@{ State = 'absent'; Marker = $null; Process = $null }
    }

    $process = Get-Process -Id ([int]$marker.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return [pscustomobject]@{ State = 'stale'; Marker = $marker; Process = $null }
    }

    try {
        $actualPath = [IO.Path]::GetFullPath($process.Path)
        $actualStartTicks = $process.StartTime.ToUniversalTime().Ticks
    }
    catch {
        throw "Cannot verify process identity for PID $($marker.pid): $($_.Exception.Message)"
    }
    if (-not (Test-SamePath -Left $actualPath -Right ([string]$marker.nodePath)) -or
        [int64]$actualStartTicks -ne [int64]$marker.processStartTimeUtcTicks) {
        throw "PID $($marker.pid) is not the marker-owned EveJS process; refusing to act on it."
    }

    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($marker.pid)"
    if ($null -eq $cimProcess -or
        [string]::IsNullOrWhiteSpace([string]$cimProcess.CommandLine) -or
        ([string]$cimProcess.CommandLine).IndexOf($ServerEntry, $script:PathComparison) -lt 0) {
        throw "PID $($marker.pid) command line does not identify $ServerEntry; refusing to act on it."
    }
    return [pscustomobject]@{ State = 'running'; Marker = $marker; Process = $process }
}

function Assert-GeneratedInputs {
    if (-not (Test-Path -LiteralPath $GeneratedData -PathType Container)) {
        throw (
            "Generated Frontier database is missing: $GeneratedData`n" +
            "Run: npm run frontier:database -- --snapshot `"$StaticRoot`""
        )
    }
    if (-not (Test-Path -LiteralPath $GeneratedManifest -PathType Leaf)) {
        throw "Generated Frontier database manifest is missing: $GeneratedManifest"
    }
    if (-not (Test-Path -LiteralPath $StaticRoot -PathType Container)) {
        throw "Frontier static snapshot is missing: $StaticRoot"
    }
}

function Initialize-Runtime {
    if (Test-Path -LiteralPath $RuntimeRoot) {
        [void](Assert-RecognizedRuntime)
        Write-Host "[evejs-frontier] Reusing marker-owned runtime for build $Build."
        return
    }

    Assert-NoReparsePathChain -Path $RuntimeRoot -Purpose 'runtime initialization'
    New-Item -ItemType Directory -Path $RuntimeBase -Force | Out-Null
    Assert-NoReparseTree -Root $RuntimeBase -Purpose 'runtime initialization'

    $initializingName = '.{0}.initializing-{1}' -f $Build, [guid]::NewGuid().ToString('N')
    $initializingRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeBase $initializingName))
    $basePrefix = $RuntimeBase.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $initializingRoot.StartsWith($basePrefix, $script:PathComparison) -or
        [IO.Path]::GetFileName($initializingRoot) -notlike ".$Build.initializing-*") {
        throw "Unsafe runtime initialization path: $initializingRoot"
    }

    try {
        $temporaryGameStore = Join-Path $initializingRoot 'gameStore'
        New-Item -ItemType Directory -Path $temporaryGameStore -Force | Out-Null
        Copy-Item -LiteralPath $GeneratedData -Destination $temporaryGameStore -Recurse -Force
        Copy-Item -LiteralPath $GeneratedManifest -Destination (
            Join-Path $initializingRoot 'generated-manifest.json'
        ) -Force

        $runtimeMarkerValue = [ordered]@{
            kind = $script:RuntimeMarkerKind
            schemaVersion = $script:RuntimeMarkerSchemaVersion
            platform = 'win32'
            build = $Build
            runtimeRoot = $RuntimeRoot
            generatedRoot = $GeneratedRoot
            staticRoot = $StaticRoot
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            metadata = [ordered]@{
                clientVersion = $ClientVersion
                machoVersion = $MachoVersion
                birthday = $Birthday
                codename = $Codename
                region = $Region
                projectVersion = $ProjectVersion
            }
        }
        Write-JsonAtomic -Path (
            Join-Path $initializingRoot '.evejs-frontier-runtime'
        ) -Value $runtimeMarkerValue
        Assert-NoReparseTree -Root $RuntimeBase -Purpose 'runtime initialization publish'
        Move-Item -LiteralPath $initializingRoot -Destination $RuntimeRoot
        Write-Host "[evejs-frontier] Created isolated runtime from generated build $Build."
    }
    finally {
        if (Test-Path -LiteralPath $initializingRoot) {
            try {
                Assert-NoReparseTree -Root $initializingRoot -Purpose 'failed initialization cleanup'
                Remove-Item -LiteralPath $initializingRoot -Recurse -Force
            }
            catch {
                Write-Warning (
                    "Failed initialization evidence was retained at ${initializingRoot}: " +
                    $_.Exception.Message
                )
            }
        }
    }
}

function Reset-OwnedRuntime {
    if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
        return
    }
    [void](Assert-RecognizedRuntime)
    Assert-RuntimeInactiveForReset

    # Repeat every ownership, process, listener, and reparse guard immediately
    # before the recursive delete so a checked path cannot be silently swapped.
    [void](Assert-RecognizedRuntime)
    Assert-RuntimeInactiveForReset
    Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
    Write-Host "[evejs-frontier] Reset marker-owned runtime for build $Build."
}

function Get-NodePath {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw 'Node.js is not available in PATH. Install Node.js 24 LTS x64 and open a fresh PowerShell.'
    }
    return [IO.Path]::GetFullPath($nodeCommand.Source)
}

function Assert-ServerDependencies {
    if (-not (Test-Path -LiteralPath $ServerEntry -PathType Leaf)) {
        throw "Server entry point is missing: $ServerEntry"
    }
    $sqliteModule = Join-Path $RepoRoot 'server\node_modules\better-sqlite3'
    if (-not (Test-Path -LiteralPath $sqliteModule -PathType Container)) {
        throw 'Server dependencies are missing. Run: npm --prefix server ci'
    }
}

function Get-RequiredFrontierListeners {
    $requiredPorts = @(26000, 26101, 26102, 26103, 5222, 26401)
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        return @(
            Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $requiredPorts -contains [int]$_.LocalPort }
        )
    }

    return @(
        [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $requiredPorts -contains [int]$_.Port } |
            ForEach-Object {
                [pscustomobject]@{
                    LocalAddress = $_.Address.ToString()
                    LocalPort = $_.Port
                    OwningProcess = 'unknown'
                }
            }
    )
}

function Get-ExactFrontierServerProcesses {
    try {
        return @(
            Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
                Where-Object {
                    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
                    -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
                    [IO.Path]::GetFileName([string]$_.ExecutablePath) -ieq 'node.exe' -and
                    ([string]$_.CommandLine).IndexOf(
                        $ServerEntry,
                        $script:PathComparison
                    ) -ge 0
                }
        )
    }
    catch {
        throw "Could not prove that no Frontier server process is active: $($_.Exception.Message)"
    }
}

function Assert-RuntimeInactiveForReset {
    if (Test-Path -LiteralPath $PidMarker) {
        $ownedProcessState = Get-OwnedProcessState
        if ($ownedProcessState.State -eq 'running') {
            throw (
                "Refusing to reset while the marker-owned server is running as PID " +
                "$($ownedProcessState.Marker.pid). Run .\StopFrontier.ps1 -Build $Build first."
            )
        }
        throw (
            "Refusing to reset while a stale PID marker exists. " +
            "Run .\StopFrontier.ps1 -Build $Build first."
        )
    }

    $listeners = @(Get-RequiredFrontierListeners)
    if ($listeners.Count -gt 0) {
        $details = $listeners |
            ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }
        throw (
            "Refusing to reset while required Frontier port(s) have listeners: " +
            ($details -join ', ')
        )
    }

    $serverProcesses = @(Get-ExactFrontierServerProcesses)
    if ($serverProcesses.Count -gt 0) {
        $details = $serverProcesses |
            ForEach-Object { "pid=$($_.ProcessId)" }
        throw (
            "Refusing to reset while an exact Frontier server process is active: " +
            ($details -join ', ')
        )
    }
}

function Assert-ListenerPortsAvailable {
    $listeners = @(Get-RequiredFrontierListeners)
    if ($listeners.Count -gt 0) {
        $details = $listeners |
            ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }
        throw "Required Frontier port(s) already have listeners: $($details -join ', ')"
    }
}

function Get-ServerEnvironment {
    $logLevel = if ($Quiet) { '1' } else { '2' }
    return [ordered]@{
        EVEJS_GAMESTORE_DATA_DIR = $RuntimeData
        EVEJS_STATIC_JSONL_ROOT = $StaticRoot
        EVEJS_CLIENT_COMPATIBILITY_PROFILE = 'frontier'
        EVEJS_CLIENT_VERSION = $ClientVersion
        EVEJS_CLIENT_BUILD = $Build
        EVEJS_EVE_BIRTHDAY = $Birthday
        EVEJS_MACHO_VERSION = [string]$MachoVersion
        EVEJS_PROJECT_CODENAME = $Codename
        EVEJS_PROJECT_REGION = $Region
        EVEJS_PROJECT_VERSION = $ProjectVersion
        EVEJS_GAME_SERVER_BIND_HOST = '127.0.0.1'
        EVEJS_GAME_SERVER_HOST = '127.0.0.1'
        EVEJS_SERVER_PORT = '26000'
        EVEJS_IMAGE_SERVER_URL = 'http://127.0.0.1:26101/'
        EVEJS_IMAGE_SERVER_BIND_HOST = '127.0.0.1'
        EVEJS_MICROSERVICES_REDIRECT_URL = 'http://127.0.0.1:26102/'
        EVEJS_MICROSERVICES_PUBLIC_BASE_URL = 'http://127.0.0.1:26102/'
        EVEJS_MICROSERVICES_BIND_HOST = '127.0.0.1'
        EVEJS_PROXY_LOOPBACK_CDN_LISTEN_PORT = '0'
        EVEJS_REDSHIFT_MONITOR_HOST = '127.0.0.1'
        EVEJS_REDSHIFT_MONITOR_PORT = '26401'
        EVEJS_XMPP_SERVER_BIND_HOST = '127.0.0.1'
        EVEJS_XMPP_SERVER_PORT = '5222'
        EVEJS_XMPP_CONNECT_HOST = '127.0.0.1'
        EVEJS_XMPP_DOMAIN = 'frontier.localhost'
        EVEJS_XMPP_CONFERENCE_DOMAIN = 'conference.frontier.localhost'
        EVEJS_DEV_AUTO_CREATE_ACCOUNTS = 'true'
        EVEJS_DEV_SKIP_PASSWORD_VALIDATION = 'true'
        EVEJS_WORMHOLES_ENABLED = 'false'
        EVEJS_MARKET_DAEMON_ENABLED = 'false'
        EVEJS_SKIP_NPC_STARTUP = '1'
        EVEJS_LOG_LEVEL = $logLevel
    }
}

function Invoke-WithChildEnvironment {
    param(
        [Parameter(Mandatory)] [System.Collections.IDictionary]$Environment,
        [Parameter(Mandatory)] [scriptblock]$Action
    )

    $originalValues = @{}
    foreach ($key in $Environment.Keys) {
        $originalValues[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    try {
        return & $Action
    }
    finally {
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $originalValues[$key], 'Process')
        }
    }
}

function Show-FrontierStatus {
    Write-Output "[evejs-frontier] Build: $Build"
    Write-Output "[evejs-frontier] Generated data: $(if (Test-Path -LiteralPath $GeneratedData -PathType Container) { 'present' } else { 'missing' })"
    Write-Output "[evejs-frontier] Static snapshot: $(if (Test-Path -LiteralPath $StaticRoot -PathType Container) { 'present' } else { 'missing' })"
    if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
        Write-Output "[evejs-frontier] Runtime: not initialized ($RuntimeRoot)"
        Write-Output '[evejs-frontier] Background process: not running'
        return
    }
    [void](Assert-RecognizedRuntime)
    Write-Output "[evejs-frontier] Runtime: initialized ($RuntimeRoot)"
    $processState = Get-OwnedProcessState
    switch ($processState.State) {
        'running' {
            Write-Output "[evejs-frontier] Background process: running pid=$($processState.Marker.pid)"
        }
        'stale' {
            Write-Output "[evejs-frontier] Background process: stale marker pid=$($processState.Marker.pid)"
        }
        default {
            Write-Output '[evejs-frontier] Background process: not running'
        }
    }
}

Assert-ContainedExactRuntimePath

if ($Status) {
    Show-FrontierStatus
    return
}

Assert-GeneratedInputs

if ($DryRun) {
    if (Test-Path -LiteralPath $RuntimeRoot) {
        [void](Assert-RecognizedRuntime)
        if ($ResetRuntime) {
            Assert-RuntimeInactiveForReset
            Write-Output "[evejs-frontier] Dry run: would reset $RuntimeRoot"
        }
        else {
            Write-Output "[evejs-frontier] Dry run: would reuse $RuntimeRoot"
        }
    }
    else {
        Write-Output "[evejs-frontier] Dry run: would initialize $RuntimeRoot"
    }
    if (-not $InitializeOnly) {
        [void](Get-NodePath)
        Assert-ServerDependencies
        Write-Output "[evejs-frontier] Dry run: would start build $Build $(if ($Background) { 'in the background' } else { 'in the foreground' })"
    }
    return
}

if ($ResetRuntime) {
    Reset-OwnedRuntime
}
Initialize-Runtime

if ($InitializeOnly) {
    Write-Output "[evejs-frontier] Runtime initialization check complete: $RuntimeRoot"
    return
}

$ownedProcessState = Get-OwnedProcessState
if ($ownedProcessState.State -eq 'running') {
    throw "Frontier server is already running as PID $($ownedProcessState.Marker.pid)."
}
if ($ownedProcessState.State -eq 'stale') {
    Remove-Item -LiteralPath $PidMarker -Force
    Write-Warning "Removed stale background PID marker for PID $($ownedProcessState.Marker.pid)."
}

$NodePath = Get-NodePath
Assert-ServerDependencies
Assert-ListenerPortsAvailable
$ServerEnvironment = Get-ServerEnvironment

Write-Host "[evejs-frontier] Runtime: $RuntimeRoot"
Write-Host '[evejs-frontier] Game TCP: 127.0.0.1:26000'
Write-Host '[evejs-frontier] Image HTTP: 127.0.0.1:26101'
Write-Host '[evejs-frontier] HTTP/bridge: 127.0.0.1:26102'
Write-Host '[evejs-frontier] Secure public gateway: 127.0.0.1:26103'
Write-Host '[evejs-frontier] XMPP: 127.0.0.1:5222'
Write-Host '[evejs-frontier] Monitor: 127.0.0.1:26401'
Write-Host (
    "[evejs-frontier] Profile: Frontier $ClientVersion build $Build, " +
    "MachoNet $MachoVersion, Placebo"
)

if ($Background) {
    $stdoutLog = Join-Path $RuntimeRoot 'server.stdout.log'
    $stderrLog = Join-Path $RuntimeRoot 'server.stderr.log'
    $quotedServerEntry = '"' + $ServerEntry + '"'
    $process = $null
    $pidMarkerWritten = $false
    try {
        $process = Invoke-WithChildEnvironment -Environment $ServerEnvironment -Action {
            Start-Process -FilePath $NodePath `
                -ArgumentList @($quotedServerEntry) `
                -WorkingDirectory $RepoRoot `
                -WindowStyle Hidden `
                -RedirectStandardOutput $stdoutLog `
                -RedirectStandardError $stderrLog `
                -PassThru
        }
        Start-Sleep -Milliseconds 750
        $process.Refresh()
        if ($process.HasExited) {
            throw (
                "Frontier server exited during startup with code $($process.ExitCode). " +
                "See $stderrLog"
            )
        }
        $pidMarkerValue = [ordered]@{
            kind = $script:PidMarkerKind
            schemaVersion = $script:PidMarkerSchemaVersion
            build = $Build
            runtimeRoot = $RuntimeRoot
            pid = $process.Id
            processStartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
            nodePath = $NodePath
            serverEntry = $ServerEntry
            startedAtUtc = [DateTime]::UtcNow.ToString('o')
            stdoutLog = $stdoutLog
            stderrLog = $stderrLog
        }
        Write-JsonAtomic -Path $PidMarker -Value $pidMarkerValue
        $pidMarkerWritten = $true
    }
    finally {
        if (-not $pidMarkerWritten -and $null -ne $process) {
            try {
                $process.Refresh()
                if (-not $process.HasExited) {
                    $process.Kill($true)
                    if (-not $process.WaitForExit(10000)) {
                        throw "PID $($process.Id) did not exit within 10 seconds."
                    }
                }
            }
            catch {
                throw (
                    "Background startup failed and the newly started child could not be " +
                    "proven stopped: $($_.Exception.Message)"
                )
            }
        }
    }
    Write-Output "[evejs-frontier] Background server started: pid=$($process.Id)"
    Write-Output "[evejs-frontier] Stop with: .\StopFrontier.ps1 -Build $Build"
    return
}

Write-Host '[evejs-frontier] Running in the foreground; press Ctrl+C to stop.'
$exitCode = 1
try {
    Invoke-WithChildEnvironment -Environment $ServerEnvironment -Action {
        & $NodePath $ServerEntry
        $script:exitCode = $LASTEXITCODE
    }
}
finally {
    if ($null -eq $exitCode) {
        $exitCode = 1
    }
}
if ($exitCode -ne 0) {
    throw "Frontier server exited with code $exitCode."
}
