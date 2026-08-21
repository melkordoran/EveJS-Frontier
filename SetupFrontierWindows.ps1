#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)] [int]$Build = 0,
    [string]$SourceRoot,
    [switch]$NonInteractive,
    [switch]$Status,
    [switch]$DryRun,
    [switch]$CopyResFiles,
    [switch]$CleanStage,
    [switch]$SkipStage,
    [switch]$ForceData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'SetupFrontierWindows.ps1 supports Windows only.' }

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'tools\frontier-client\FrontierWindows.Common.psm1') -Force

function Write-SetupStep { param([string]$Message) Write-Host "[evejs-frontier] $Message" -ForegroundColor Cyan }

function Invoke-WingetInstall {
    param([Parameter(Mandatory)] [string]$Id)
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) { throw "winget is required to install missing prerequisite $Id." }
    Write-SetupStep "Installing missing prerequisite: $Id"
    & $winget.Source install --exact --id $Id --accept-package-agreements `
        --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install $Id (exit $LASTEXITCODE)." }
}

function Get-GitPath {
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($git) { return $git.Source }
    $candidate = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return $null
}

function Get-PrerequisiteReport {
    $git = Get-GitPath
    $node = $null
    $python = $null
    try { $node = Get-FrontierNodePath } catch {}
    try { $python = Get-FrontierPython312Path } catch {}
    $gitVersion = if ($git) { (& $git --version) -replace '^git version\s+', '' } else { $null }
    $nodeVersion = if ($node) { (& $node --version).Trim() } else { $null }
    $npmVersion = if ($node) { (& (Join-Path (Split-Path -Parent $node) 'npm.cmd') --version).Trim() } else { $null }
    $pythonVersion = if ($python) { (& $python --version 2>&1).ToString().Trim() } else { $null }
    return [ordered]@{
        git = $gitVersion
        powerShell = $PSVersionTable.PSVersion.ToString()
        node = $nodeVersion
        npm = $npmVersion
        python = $pythonVersion
        nodePath = $node
        pythonPath = $python
    }
}

function Ensure-Prerequisites {
    if (-not (Get-GitPath)) { Invoke-WingetInstall 'Git.Git' }
    try { [void](Get-FrontierNodePath) } catch { Invoke-WingetInstall 'OpenJS.NodeJS.LTS' }
    try { [void](Get-FrontierPython312Path) } catch { Invoke-WingetInstall 'Python.Python.3.12' }

    $node = Get-FrontierNodePath
    $nodeVersion = (& $node --version).Trim()
    if ($nodeVersion -notmatch '^v24\.') {
        throw "Node.js 24 LTS is required; resolved $nodeVersion at $node"
    }
    $python = Get-FrontierPython312Path
    $implementation = & $python -c 'import platform; print(platform.python_implementation())'
    if ($implementation.Trim() -ne 'CPython') { throw 'CPython 3.12 x64 is required.' }
}

$report = Get-PrerequisiteReport
if ($Status) {
    Write-Output ($report | ConvertTo-Json -Depth 4)
    try {
        $client = Invoke-FrontierDiscovery -RepoRoot $RepoRoot -SourceRoot $SourceRoot -Build $Build
        Write-Output "[evejs-frontier] Installed Frontier: build=$($client.metadata.build) sync=$($client.metadata.sync) root=$($client.buildRoot)"
        & (Join-Path $RepoRoot 'StageFrontierClient.ps1') -SourceRoot $client.buildRoot `
            -Build ([int]$client.metadata.build) -Status
        & (Join-Path $RepoRoot 'StartFrontierServer.ps1') -Build ([string]$client.metadata.build) -Status
    }
    catch { Write-Warning $_.Exception.Message }
    return
}

if ($DryRun) {
    Write-Output ($report | ConvertTo-Json -Depth 4)
    $client = Invoke-FrontierDiscovery -RepoRoot $RepoRoot -SourceRoot $SourceRoot -Build $Build
    & (Join-Path $RepoRoot 'StageFrontierClient.ps1') -SourceRoot $client.buildRoot `
        -Build ([int]$client.metadata.build) -CopyResFiles:$CopyResFiles -DryRun
    return
}

Ensure-Prerequisites
$node = Get-FrontierNodePath
$npm = Get-FrontierNpmPath
$systemPython = Get-FrontierPython312Path
$nodeDirectory = Split-Path -Parent $node
$oldPath = $env:Path
$env:Path = "$nodeDirectory;$oldPath"
try {
    Write-SetupStep 'Installing locked root Node dependencies ...'
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Root npm ci failed.' }
    Write-SetupStep 'Installing locked server Node dependencies ...'
    & $npm --prefix server ci
    if ($LASTEXITCODE -ne 0) { throw 'Server npm ci failed.' }

    & $node -e "const D=require('./server/node_modules/better-sqlite3'); const d=new D(':memory:'); console.log(d.prepare('select sqlite_version() v').get().v); d.close();"
    if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 failed its Node ABI in-memory probe.' }

    $venv = Join-Path $RepoRoot '_local\frontier-python312'
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Write-SetupStep 'Creating the ignored CPython 3.12 environment ...'
        & $systemPython -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 venv creation failed.' }
    }
    & $venvPython -m pip install -r (Join-Path $RepoRoot 'tools\frontier-client\requirements-windows-frontier.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Frontier Windows Python dependency installation failed.' }

    Write-SetupStep 'Generating or reusing local TLS certificates ...'
    & (Join-Path $RepoRoot 'tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1') -SkipClientBundles
    foreach ($privateFile in @(
        (Join-Path $RepoRoot 'server\certs\xmpp-ca-key.pem'),
        (Join-Path $RepoRoot 'server\certs\xmpp-dev-key.pem'),
        (Join-Path $RepoRoot 'server\src\_secondary\express\certs\gateway-dev-key.pem')
    )) { Set-FrontierPrivateFileAcl $privateFile }

    $client = Invoke-FrontierDiscovery -RepoRoot $RepoRoot -SourceRoot $SourceRoot -Build $Build
    $Build = [int]$client.metadata.build
    $snapshot = Join-Path $RepoRoot "_local\frontier-sde\$Build"
    $contracts = Join-Path $RepoRoot "_local\frontier-contracts\$Build"
    $database = Join-Path $RepoRoot "_local\frontier-gameStore\$Build\data"

    if (-not (Test-Path -LiteralPath (Join-Path $snapshot 'frontier-extraction-manifest.json')) -or $ForceData) {
        Write-SetupStep "Extracting untouched Frontier build $Build static data ..."
        $extractArgs = @('run', 'frontier:extract', '--', '--client-root', [string]$client.buildRoot, '--build', [string]$Build)
        if ($ForceData) { $extractArgs += '--force' }
        & $npm @extractArgs
        if ($LASTEXITCODE -ne 0) { throw 'Frontier static extraction failed.' }
    }
    & $npm run frontier:validate -- --snapshot $snapshot
    if ($LASTEXITCODE -ne 0) { throw 'Frontier static validation failed.' }

    if (-not (Test-Path -LiteralPath (Join-Path $contracts 'frontier-contract-manifest.json')) -or $ForceData) {
        Write-SetupStep "Exporting Frontier build $Build public contracts ..."
        $contractArgs = @('run', 'frontier:contracts', '--', '--client-root', [string]$client.buildRoot, '--build', [string]$Build)
        if ($ForceData) { $contractArgs += '--force' }
        & $npm @contractArgs
        if ($LASTEXITCODE -ne 0) { throw 'Frontier contract export failed.' }
    }

    if (-not (Test-Path -LiteralPath $database) -or $ForceData) {
        Write-SetupStep "Generating the isolated Frontier build $Build database ..."
        $databaseArgs = @('run', 'frontier:database', '--', '--snapshot', $snapshot)
        if ($ForceData) { $databaseArgs += '--force' }
        & $npm @databaseArgs
        if ($LASTEXITCODE -ne 0) { throw 'Frontier database generation failed.' }
    }

    if (-not $SkipStage) {
        & (Join-Path $RepoRoot 'StageFrontierClient.ps1') -SourceRoot $client.buildRoot `
            -Build $Build -CopyResFiles:$CopyResFiles -Clean:$CleanStage
    }
    Write-SetupStep "Windows Frontier setup completed for build $Build."
}
finally {
    $env:Path = $oldPath
}
