#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^\d+$')] [string]$Build = '3474408',
    [string]$StagedRoot,
    [ValidateSet('127.0.0.1')] [string]$ServerHost = '127.0.0.1',
    [ValidatePattern('^[A-Za-z0-9._-]+$')] [string]$SettingsProfile = 'EveJSFrontier',
    [string]$SessionFile,
    [switch]$UseCapturedSession,
    [switch]$Background,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'PlayFrontier.ps1 supports Windows only.' }

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'tools\frontier-client\FrontierWindows.Common.psm1') -Force
$WindowsRoot = Join-Path $env:LOCALAPPDATA 'EveJS-Frontier\windows'
if (-not $StagedRoot) { $StagedRoot = Join-Path $WindowsRoot "staged-client\$Build" }
$StagedRoot = [IO.Path]::GetFullPath($StagedRoot)
$marker = Read-FrontierStageMarker -StageRoot $StagedRoot -ExpectedBuild ([int]$Build)

& (Join-Path $RepoRoot 'PatchFrontierClientTrust.ps1') -StagedRoot $StagedRoot -Check | Out-Host

$exefile = Join-Path $StagedRoot 'bin64\exefile.exe'
$workDir = Join-Path $StagedRoot 'bin64'
$resFiles = Join-Path $StagedRoot 'ResFiles'
$logRoot = Join-Path $WindowsRoot "logs\$Build"
$clientPidMarker = Join-Path $logRoot 'client.pid.json'
if (-not $SessionFile) { $SessionFile = Join-Path $WindowsRoot 'launcher-session.args' }
$arguments = [Collections.Generic.List[string]]::new()
$arguments.Add('/noconsole')

if ($UseCapturedSession -or $PSBoundParameters.ContainsKey('SessionFile')) {
    if (-not (Test-Path -LiteralPath $SessionFile -PathType Leaf)) {
        throw "Captured launcher session is missing: $SessionFile"
    }
    $acl = Get-Acl -LiteralPath $SessionFile
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $unexpected = @($acl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate(
            [Security.Principal.SecurityIdentifier]).Value -ne $currentSid
    })
    if ($unexpected.Count -gt 0) {
        throw "Captured launcher session ACL is not restricted to the current user: $SessionFile"
    }
    foreach ($line in Get-Content -LiteralPath $SessionFile) {
        $value = $line.Trim()
        if ($value -and -not $value.StartsWith('#')) { $arguments.Add($value) }
    }
}

function Set-LaunchArgument {
    param([string]$Prefix, [string]$Value)
    for ($index = $arguments.Count - 1; $index -ge 0; $index--) {
        if ($arguments[$index].StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
            $arguments.RemoveAt($index)
        }
    }
    $arguments.Add($Value)
}

Set-LaunchArgument '/noconsole' '/noconsole'
Set-LaunchArgument '/server:' "/server:$ServerHost"
Set-LaunchArgument '/settingsprofile=' "/settingsprofile=$SettingsProfile"
Set-LaunchArgument '/language=' '/language=en'
Set-LaunchArgument '/cryptoPack=' '/cryptoPack=Placebo'
Set-LaunchArgument '/remotefilecachefolder=' "/remotefilecachefolder=$resFiles"

$redacted = @($arguments | ForEach-Object { Protect-FrontierLaunchArgument $_ })
Write-Host "[evejs-frontier] Client: $exefile"
Write-Host '[evejs-frontier] Server: 127.0.0.1:26000'
Write-Host "[evejs-frontier] ResFiles: $resFiles ($($marker.resFiles.mode))"
Write-Host "[evejs-frontier] Arguments: $($redacted -join ' ')"
if ($DryRun) {
    Write-Output '[evejs-frontier] Dry run: staged -Check passed; no process was started.'
    return
}

$jsonlPath = Join-Path $logRoot 'logs-client.jsonl'
$environment = @{
    EO_REMOTEFILECACHEFOLDER = $resFiles
    FRONTIER_PUBLIC_GATEWAY_ADDRESS = '127.0.0.1:26103'
    FRONTIER_PUBLIC_GATEWAY_IS_SECURE = '1'
    'JSONL-LOGPATH' = $logRoot
}

if ($Background) {
    $stdout = Join-Path $logRoot 'client-stdout.log'
    $stderr = Join-Path $logRoot 'client-stderr.log'
    $mutex = $null
    $mutexTaken = $false
    try {
        $mutex = [Threading.Mutex]::new($false, "Local\EveJS-Frontier-Client-$Build")
        try {
            $mutexTaken = $mutex.WaitOne(0)
        }
        catch [Threading.AbandonedMutexException] {
            $mutexTaken = $true
        }
        if (-not $mutexTaken) {
            throw "Another background-client launch is already in progress for build $Build."
        }

        $existingState = Get-FrontierClientProcessState -MarkerPath $clientPidMarker `
            -Build ([int]$Build)
        if ($existingState.State -eq 'running') {
            throw "A marker-owned background client is already running for build $Build (pid=$($existingState.Marker.pid))."
        }
        if ($existingState.State -eq 'stale') {
            Remove-Item -LiteralPath $clientPidMarker -Force
            Write-Output "[evejs-frontier] Removed stale background-client marker for pid=$($existingState.Marker.pid)."
        }

        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
        [IO.File]::WriteAllText($jsonlPath, '', [Text.UTF8Encoding]::new($false))
        $process = $null
        $processStartTicks = [int64]0
        try {
            $process = Start-Process -FilePath $exefile -ArgumentList $arguments.ToArray() `
                -WorkingDirectory $workDir -Environment $environment `
                -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
            $process.Refresh()
            $processStartTicks = $process.StartTime.ToUniversalTime().Ticks
            $pidMarker = [ordered]@{
                format = 'evejs-frontier-client-process-v1'
                build = [int]$Build
                stageRoot = $StagedRoot
                exefile = $exefile
                pid = $process.Id
                processStartTimeUtcTicks = $processStartTicks
                startedAtUtc = [DateTime]::UtcNow.ToString('o')
                stdoutLog = $stdout
                stderrLog = $stderr
                jsonlLog = $jsonlPath
            }
            Write-FrontierJsonAtomic -Path $clientPidMarker -Value $pidMarker
            $process.Refresh()
            if ($process.HasExited) {
                throw "The staged Frontier client exited before its PID marker could be confirmed."
            }
        }
        catch {
            $launchError = $_
            $cleanupFailures = [Collections.Generic.List[string]]::new()
            if ($null -ne $process) {
                try {
                    $process.Refresh()
                    if (-not $process.HasExited) {
                        $process.Kill($true)
                        if (-not $process.WaitForExit(5000)) {
                            throw "Started client pid=$($process.Id) did not exit during rollback."
                        }
                    }
                }
                catch { $cleanupFailures.Add($_.Exception.Message) }
            }
            if ($null -ne $process -and
                (Test-Path -LiteralPath $clientPidMarker -PathType Leaf)) {
                try {
                    $writtenMarker = Get-Content -LiteralPath $clientPidMarker -Raw | ConvertFrom-Json
                    if ([int64]$writtenMarker.pid -eq [int64]$process.Id -and
                        [int64]$writtenMarker.processStartTimeUtcTicks -eq $processStartTicks) {
                        Remove-Item -LiteralPath $clientPidMarker -Force
                    }
                }
                catch { $cleanupFailures.Add($_.Exception.Message) }
            }
            if ($cleanupFailures.Count -gt 0) {
                throw "Background-client launch failed ($($launchError.Exception.Message)); rollback also failed: $($cleanupFailures -join '; ')"
            }
            throw $launchError
        }

        Write-Output "[evejs-frontier] Background client started: pid=$($process.Id)"
        return
    }
    finally {
        if ($mutexTaken) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
    }
}

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
[IO.File]::WriteAllText($jsonlPath, '', [Text.UTF8Encoding]::new($false))
$original = @{}
foreach ($key in $environment.Keys) {
    $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process')
}
try {
    Push-Location $workDir
    try { & $exefile @arguments }
    finally { Pop-Location }
}
finally {
    foreach ($key in $environment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $original[$key], 'Process')
    }
}
