#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$StagedRoot,
    [switch]$Check,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'PatchFrontierClientTrust.ps1 supports Windows only.' }

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'tools\frontier-client\FrontierWindows.Common.psm1') -Force
$StagedRoot = [IO.Path]::GetFullPath($StagedRoot)
$marker = Read-FrontierStageMarker -StageRoot $StagedRoot
$node = Get-FrontierNodePath
$python = Get-FrontierPython312Path -RepoRoot $RepoRoot
$ca = Join-Path $RepoRoot 'server\certs\xmpp-ca-cert.pem'
$caKey = Join-Path $RepoRoot 'server\certs\xmpp-ca-key.pem'
$xmppKey = Join-Path $RepoRoot 'server\certs\xmpp-dev-key.pem'
$gatewayKey = Join-Path $RepoRoot 'server\src\_secondary\express\certs\gateway-dev-key.pem'

if ($DryRun) {
    Write-Output "[evejs-frontier] Dry run: stage marker build $($marker.build) is structurally valid."
    Write-Output "[evejs-frontier] Dry run: would $(if ($Check) { 'verify' } else { 'patch transaction for' }) $StagedRoot"
    return
}

if (-not $Check) {
    $nodeDirectory = Split-Path -Parent $node
    $oldPath = $env:Path
    try {
        $env:Path = "$nodeDirectory;$oldPath"
        & (Join-Path $RepoRoot 'tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1') `
            -SkipClientBundles
    }
    finally {
        $env:Path = $oldPath
    }
    foreach ($privateFile in @($caKey, $xmppKey, $gatewayKey)) {
        Set-FrontierPrivateFileAcl -Path $privateFile
    }
}

foreach ($required in @(
    $ca,
    (Join-Path $RepoRoot 'server\certs\xmpp-dev-cert.pem'),
    (Join-Path $RepoRoot 'server\src\_secondary\express\certs\gateway-dev-cert.pem')
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required EveJS certificate is missing: $required"
    }
}

function Assert-FrontierPlatformTrust {
    $exefile = Join-Path $StagedRoot 'bin64\exefile.exe'
    if (-not (Test-Path -LiteralPath $exefile -PathType Leaf)) {
        throw "Staged exefile.exe is missing: $exefile"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $exefile
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "Staged exefile.exe Authenticode signature is not valid: $($signature.Status)"
    }
    $caCertificate = Get-PfxCertificate -FilePath $ca
    $trusted = @(Get-ChildItem Cert:\CurrentUser\Root |
        Where-Object { $_.Thumbprint -eq $caCertificate.Thumbprint })
    if ($trusted.Count -ne 1) {
        throw "The EveJS public CA trust count in Cert:\CurrentUser\Root is $($trusted.Count), not one."
    }
}

# These platform checks are deliberately completed before Python can mutate the
# stage. Python never changes exefile.exe or the CurrentUser trust store, so a
# failure here cannot leave a successful stage marker after a partial wrapper run.
Assert-FrontierPlatformTrust

$command = if ($Check) { 'check' } else { 'patch' }
$tool = Join-Path $RepoRoot 'tools\frontier-client\frontier_windows_client.py'
$output = & $python $tool $command --staged-root $StagedRoot --node $node
if ($LASTEXITCODE -ne 0) {
    throw "Frontier client $command failed."
}
try { $report = ($output -join [Environment]::NewLine) | ConvertFrom-Json }
catch { throw "Frontier client verifier returned invalid JSON: $($_.Exception.Message)" }

$report | Add-Member -NotePropertyName exefileAuthenticode -NotePropertyValue 'Valid' -Force
$report | Add-Member -NotePropertyName caTrustedCurrentUser -NotePropertyValue $true -Force
$report | ConvertTo-Json -Depth 12 -Compress
