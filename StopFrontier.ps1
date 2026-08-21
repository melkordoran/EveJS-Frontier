#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^\d+$')]
    [string]$Build = '3474408',

    [ValidateRange(1, 300)]
    [int]$WaitSeconds = 15,

    [string]$StagedRoot,

    [switch]$ClientOnly,
    [switch]$ServerOnly,
    [switch]$Status,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'StopFrontier.ps1 supports Windows only.'
}
if ($ClientOnly -and $ServerOnly) {
    throw '-ClientOnly and -ServerOnly cannot be used together.'
}

$script:RuntimeMarkerKind = 'evejs-frontier-runtime'
$script:RuntimeMarkerSchemaVersion = 1
$script:PidMarkerKind = 'evejs-frontier-server-process'
$script:PidMarkerSchemaVersion = 1
$script:PathComparison = [StringComparison]::OrdinalIgnoreCase

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'tools\frontier-client\FrontierWindows.Common.psm1') -Force
$RuntimeBase = [IO.Path]::GetFullPath(
    (Join-Path $RepoRoot '_local\frontier-runtime')
)
$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeBase $Build))
$ExpectedRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeBase $Build))
$RuntimeMarker = Join-Path $RuntimeRoot '.evejs-frontier-runtime'
$PidMarker = Join-Path $RuntimeRoot '.evejs-frontier-server.pid.json'
$ServerEntry = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'server\index.js'))
$WindowsRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:LOCALAPPDATA 'EveJS-Frontier\windows')
)
$DefaultStageBase = [IO.Path]::GetFullPath((Join-Path $WindowsRoot 'staged-client'))
if (-not $StagedRoot) {
    $StagedRoot = Join-Path $DefaultStageBase $Build
}
$ExpectedStageRoot = [IO.Path]::GetFullPath($StagedRoot)
if ([IO.Path]::GetFileName($ExpectedStageRoot.TrimEnd('\', '/')) -ne $Build) {
    throw "Staged client root is not build-numbered for build ${Build}: $ExpectedStageRoot"
}
$ClientPidMarker = [IO.Path]::GetFullPath(
    (Join-Path $WindowsRoot "logs\$Build\client.pid.json")
)

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
    if (-not $RuntimeRoot.StartsWith($basePrefix, $script:PathComparison) -or
        [IO.Path]::GetFileName($RuntimeRoot) -ne $Build) {
        throw "Runtime path escapes the marker-owned build location: $RuntimeRoot"
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

function Assert-RecognizedRuntime {
    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
        throw "Frontier runtime is missing: $RuntimeRoot"
    }
    if (-not (Test-Path -LiteralPath $RuntimeMarker -PathType Leaf)) {
        throw "Refusing an unrecognized runtime without its marker: $RuntimeRoot"
    }

    $raw = Get-Content -LiteralPath $RuntimeMarker -Raw
    if ($raw.Trim() -eq "build=$Build") {
        return
    }
    try {
        $marker = $raw | ConvertFrom-Json
    }
    catch {
        throw "Runtime marker is malformed: $RuntimeMarker"
    }
    Assert-RequiredProperties -Value $marker -Names @(
        'kind', 'schemaVersion', 'build', 'runtimeRoot'
    ) -Description 'Runtime marker'
    if ($marker.kind -ne $script:RuntimeMarkerKind -or
        [int]$marker.schemaVersion -ne $script:RuntimeMarkerSchemaVersion -or
        [string]$marker.build -ne $Build -or
        -not (Test-SamePath -Left ([string]$marker.runtimeRoot) -Right $RuntimeRoot)) {
        throw "Runtime marker is not owned by build ${Build}: $RuntimeMarker"
    }
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
        [int]$marker.schemaVersion -ne $script:PidMarkerSchemaVersion -or
        [string]$marker.build -ne $Build -or
        -not (Test-SamePath -Left ([string]$marker.runtimeRoot) -Right $RuntimeRoot) -or
        -not (Test-SamePath -Left ([string]$marker.serverEntry) -Right $ServerEntry) -or
        [int64]$marker.pid -le 0 -or
        [int64]$marker.processStartTimeUtcTicks -le 0) {
        throw "Server PID marker is not an exact build-owned process record: $PidMarker"
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
        throw "PID $($marker.pid) is not the marker-owned EveJS process; refusing to stop it."
    }

    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($marker.pid)" -ErrorAction SilentlyContinue
    if ($null -eq $cimProcess) {
        if ($null -eq (Get-Process -Id ([int]$marker.pid) -ErrorAction SilentlyContinue)) {
            return [pscustomobject]@{ State = 'stale'; Marker = $marker; Process = $null }
        }
        throw "Cannot inspect the command line for PID $($marker.pid); refusing to stop it."
    }
    if ([string]::IsNullOrWhiteSpace([string]$cimProcess.CommandLine) -or
        ([string]$cimProcess.CommandLine).IndexOf($ServerEntry, $script:PathComparison) -lt 0) {
        throw "PID $($marker.pid) command line does not identify $ServerEntry; refusing to stop it."
    }
    return [pscustomobject]@{ State = 'running'; Marker = $marker; Process = $process }
}

function Invoke-ClientStop {
    $state = Get-FrontierClientProcessState -MarkerPath $ClientPidMarker `
        -Build ([int]$Build) -ExpectedStageRoot $ExpectedStageRoot
    if ($Status) {
        switch ($state.State) {
            'running' { Write-Output "[evejs-frontier] Background client: running pid=$($state.Marker.pid)" }
            'stale' { Write-Output "[evejs-frontier] Background client: stale marker pid=$($state.Marker.pid)" }
            default { Write-Output '[evejs-frontier] Background client: not running' }
        }
        return
    }
    if ($state.State -eq 'absent') {
        Write-Output "[evejs-frontier] No marker-owned background client is running for build $Build."
        return
    }
    if ($state.State -eq 'stale') {
        if ($DryRun) {
            Write-Output "[evejs-frontier] Dry run: would remove stale client PID marker for pid=$($state.Marker.pid)"
        } else {
            Remove-Item -LiteralPath $ClientPidMarker -Force
            Write-Output "[evejs-frontier] Removed stale client PID marker for pid=$($state.Marker.pid)."
        }
        return
    }
    if ($DryRun) {
        Write-Output "[evejs-frontier] Dry run: would stop marker-owned client pid=$($state.Marker.pid)"
        return
    }
    Stop-Process -Id ([int]$state.Marker.pid) -Force
    try { Wait-Process -Id ([int]$state.Marker.pid) -Timeout $WaitSeconds -ErrorAction Stop }
    catch {
        if (Get-Process -Id ([int]$state.Marker.pid) -ErrorAction SilentlyContinue) {
            throw "Marker-owned client PID $($state.Marker.pid) did not stop within $WaitSeconds seconds."
        }
    }
    if (Get-Process -Id ([int]$state.Marker.pid) -ErrorAction SilentlyContinue) {
        throw "Marker-owned client PID $($state.Marker.pid) is still running; PID marker was retained."
    }
    Remove-Item -LiteralPath $ClientPidMarker -Force
    Write-Output "[evejs-frontier] Stopped marker-owned Frontier client pid=$($state.Marker.pid)."
}

if (-not $ServerOnly) {
    Invoke-ClientStop
}
if ($ClientOnly) {
    return
}

Assert-ContainedExactRuntimePath

if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
    Write-Output "[evejs-frontier] Runtime is not initialized for build $Build."
    Write-Output '[evejs-frontier] Background process: not running'
    return
}

Assert-RecognizedRuntime
$processState = Get-OwnedProcessState

if ($Status) {
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
    return
}

if ($processState.State -eq 'absent') {
    Write-Output "[evejs-frontier] No marker-owned background server is running for build $Build."
    return
}

if ($processState.State -eq 'stale') {
    if ($DryRun) {
        Write-Output "[evejs-frontier] Dry run: would remove stale PID marker for pid=$($processState.Marker.pid)"
        return
    }
    Remove-Item -LiteralPath $PidMarker -Force
    Write-Output "[evejs-frontier] Removed stale PID marker for pid=$($processState.Marker.pid)."
    return
}

if ($DryRun) {
    Write-Output "[evejs-frontier] Dry run: would stop marker-owned pid=$($processState.Marker.pid)"
    return
}

Stop-Process -Id ([int]$processState.Marker.pid) -Force
try {
    Wait-Process -Id ([int]$processState.Marker.pid) -Timeout $WaitSeconds -ErrorAction Stop
}
catch {
    if ($null -ne (Get-Process -Id ([int]$processState.Marker.pid) -ErrorAction SilentlyContinue)) {
        throw "Marker-owned PID $($processState.Marker.pid) did not stop within $WaitSeconds seconds."
    }
}

if ($null -ne (Get-Process -Id ([int]$processState.Marker.pid) -ErrorAction SilentlyContinue)) {
    throw "Marker-owned PID $($processState.Marker.pid) is still running; PID marker was retained."
}
Remove-Item -LiteralPath $PidMarker -Force
Write-Output "[evejs-frontier] Stopped marker-owned Frontier server pid=$($processState.Marker.pid)."
