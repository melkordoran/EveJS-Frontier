#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$OutputPath = (Join-Path $env:LOCALAPPDATA 'EveJS-Frontier\windows\launcher-session.args')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'CaptureFrontierSession.ps1 supports Windows only.' }

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'tools\frontier-client\FrontierWindows.Common.psm1') -Force
$client = Invoke-FrontierDiscovery -RepoRoot $RepoRoot -SourceRoot $SourceRoot
$officialExe = [IO.Path]::GetFullPath([string]$client.files.executable)
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'exefile.exe'" |
    Where-Object {
        $_.ExecutablePath -and (Test-FrontierSamePath $_.ExecutablePath $officialExe) -and
        $_.CommandLine -match '(?i)/ssoToken='
    })
if ($matches.Count -ne 1) {
    throw "Expected exactly one launcher-owned Frontier exefile.exe with a session; found $($matches.Count)."
}

$commandLine = [string]$matches[0].CommandLine
$tokens = [Management.Automation.PSParser]::Tokenize($commandLine, [ref]$null) |
    Where-Object { $_.Type -in @('CommandArgument', 'String') } |
    ForEach-Object { $_.Content }
$allowed = @($tokens | Where-Object {
    $_ -match '(?i)^/(noconsole|server:|ssoToken=|refreshToken=|settingsprofile=|language=|LauncherData=|deviceID=|machineHash=|journeyID=)' -or
    $_ -match '^exp='
})
if (-not ($allowed | Where-Object { $_ -match '(?i)^/ssoToken=' })) {
    throw 'The launcher process did not expose a usable SSO token argument.'
}

$OutputPath = [IO.Path]::GetFullPath($OutputPath)
Write-FrontierPrivateLinesAtomic -Path $OutputPath -Lines $allowed
Write-Output "[evejs-frontier] Captured $($allowed.Count) launcher arguments to a current-user-only file."
Write-Output '[evejs-frontier] Credential values were not displayed.'
