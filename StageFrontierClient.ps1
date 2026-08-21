#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)]
    [int]$Build = 0,
    [string]$SourceRoot,
    [string]$StagingBase = (Join-Path $env:LOCALAPPDATA 'EveJS-Frontier\windows\staged-client'),
    [switch]$CopyResFiles,
    [switch]$Clean,
    [switch]$NoPatch,
    [switch]$Status,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'StageFrontierClient.ps1 supports Windows only.' }

$RepoRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'tools\frontier-client\FrontierWindows.Common.psm1') -Force
$StagingBase = [IO.Path]::GetFullPath($StagingBase)

function Get-RetailHashes {
    param([string]$BuildRoot, [string]$NativeBlue)
    $relativeFiles = [Collections.Generic.List[string]]::new()
    foreach ($relative in @(
        "bin64/$NativeBlue",
        'code.ccp',
        'manifest.dat',
        'bin64/cacert.pem',
        'bin64/packages/certifi/cacert.pem',
        'bin64/exefile.exe'
    )) { $relativeFiles.Add($relative) }
    Get-ChildItem -LiteralPath $BuildRoot -File -Filter '*.ini' | ForEach-Object {
        $relativeFiles.Add($_.Name)
    }
    $hashes = [ordered]@{}
    foreach ($relative in $relativeFiles | Select-Object -Unique) {
        $nativeRelative = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $hashes[$relative] = Get-FrontierSha256 (Join-Path $BuildRoot $nativeRelative)
    }
    return $hashes
}

function Assert-NoReparsePathChain {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [switch]$RequireLeafDirectory
    )
    $currentPath = [IO.Path]::GetFullPath($Path)
    $isLeaf = $true
    while ($true) {
        $item = $null
        try {
            $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        }
        catch {
            if ($_.Exception -isnot [Management.Automation.ItemNotFoundException] -and
                $_.Exception -isnot [IO.DirectoryNotFoundException] -and
                $_.Exception -isnot [IO.FileNotFoundException]) {
                throw
            }
        }
        if ($item) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a reparse-point staging path component: $currentPath"
            }
            if (-not ($item.Attributes -band [IO.FileAttributes]::Directory)) {
                throw "Staging path component is not a directory: $currentPath"
            }
        } elseif ($isLeaf -and $RequireLeafDirectory) {
            throw "Required staging directory is missing: $currentPath"
        }
        $parent = Split-Path -Parent $currentPath
        if (-not $parent -or (Test-FrontierSamePath $parent $currentPath)) { break }
        $currentPath = $parent
        $isLeaf = $false
    }
}

function Get-FinalDirectoryPath {
    param([Parameter(Mandatory)] [string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not ($item.Attributes -band [IO.FileAttributes]::Directory)) {
        throw "Expected a directory: $Path"
    }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $item = $item.ResolveLinkTarget($true)
        if (-not $item -or
            -not ($item.Attributes -band [IO.FileAttributes]::Directory)) {
            throw "Could not resolve directory reparse-point target: $Path"
        }
    }
    return [IO.Path]::GetFullPath($item.FullName)
}

function Assert-JunctionTarget {
    param(
        [Parameter(Mandatory)] [string]$JunctionPath,
        [Parameter(Mandatory)] [string]$ExpectedTarget
    )
    $junction = Get-Item -LiteralPath $JunctionPath -Force -ErrorAction Stop
    if (-not ($junction.Attributes -band [IO.FileAttributes]::Directory) -or
        -not ($junction.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $junction.LinkType -ne 'Junction') {
        throw "Expected a directory junction: $JunctionPath"
    }
    $actualFinal = Get-FinalDirectoryPath -Path $JunctionPath
    $expectedFinal = Get-FinalDirectoryPath -Path $ExpectedTarget
    if (-not (Test-FrontierSamePath $actualFinal $expectedFinal)) {
        throw "Junction target changed: $JunctionPath resolves to $actualFinal, expected $expectedFinal"
    }
}

function Assert-NoUnexpectedReparsePoints {
    param([string]$Root, [string]$AllowedResFiles)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    Assert-NoReparsePathChain -Path $Root -RequireLeafDirectory
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push([IO.Path]::GetFullPath($Root))
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                if (-not $AllowedResFiles -or
                    -not (Test-FrontierSamePath $item.FullName $AllowedResFiles)) {
                    throw "Unexpected reparse point in marker-owned stage: $($item.FullName)"
                }
                # Never traverse even the one allowed junction. Its final target is
                # checked separately against the discovered official ResFiles root.
                continue
            }
            if ($item.Attributes -band [IO.FileAttributes]::Directory) {
                $pending.Push($item.FullName)
            }
        }
    }
}

function Get-ValidatedStageMarker {
    param(
        [Parameter(Mandatory)] [string]$StageRoot,
        [Parameter(Mandatory)] [int]$ExpectedBuild,
        [Parameter(Mandatory)] [string]$ExpectedResFilesTarget
    )
    Assert-NoReparsePathChain -Path $StageRoot -RequireLeafDirectory
    $resFilesPath = Join-Path $StageRoot 'ResFiles'

    # This first pass is deliberately independent of marker contents, so a
    # reparse-point marker (or any nested escape) is rejected before it is read.
    Assert-NoUnexpectedReparsePoints -Root $StageRoot -AllowedResFiles $resFilesPath
    $marker = Read-FrontierStageMarker -StageRoot $StageRoot `
        -ExpectedBase $StagingBase -ExpectedBuild $ExpectedBuild
    if (-not $marker.resFiles -or
        -not (Test-FrontierSamePath ([string]$marker.resFiles.path) $resFilesPath)) {
        throw 'Marker ResFiles path does not match the marker-owned stage.'
    }

    if ($marker.resFiles.mode -eq 'junction') {
        if (-not (Test-FrontierSamePath `
                ([string]$marker.resFiles.target) $ExpectedResFilesTarget)) {
            throw 'Marker ResFiles target does not match the discovered official cache.'
        }
        Assert-JunctionTarget -JunctionPath $resFilesPath `
            -ExpectedTarget $ExpectedResFilesTarget
    } elseif ($marker.resFiles.mode -eq 'copy') {
        if (-not (Test-FrontierSamePath `
                ([string]$marker.resFiles.sourceTarget) $ExpectedResFilesTarget)) {
            throw 'Marker copied ResFiles source does not match the discovered official cache.'
        }
        if (-not (Test-Path -LiteralPath $resFilesPath -PathType Container)) {
            throw 'Marker declares copied ResFiles, but the directory is missing.'
        }
        Assert-NoUnexpectedReparsePoints -Root $StageRoot
    } else {
        throw "Unsupported ResFiles staging mode: $($marker.resFiles.mode)"
    }
    return $marker
}

function Assert-StagedClientNotRunning {
    param(
        [Parameter(Mandatory)] [string]$StageRoot,
        [Parameter(Mandatory)] [int]$ExpectedBuild
    )
    $expectedExefile = [IO.Path]::GetFullPath((Join-Path $StageRoot 'bin64\exefile.exe'))
    $windowsRoot = Join-Path $env:LOCALAPPDATA 'EveJS-Frontier\windows'
    $pidMarker = Join-Path $windowsRoot "logs\$ExpectedBuild\client.pid.json"

    if (Test-Path -LiteralPath $pidMarker -PathType Leaf) {
        try {
            $record = Read-FrontierClientProcessMarker -MarkerPath $pidMarker `
                -Build $ExpectedBuild
        }
        catch {
            throw "Refusing cleanup because the Frontier client PID marker cannot be verified: $($_.Exception.Message)"
        }
        if ($record -and (Test-FrontierSamePath ([string]$record.exefile) $expectedExefile)) {
            $state = Get-FrontierClientProcessState -MarkerPath $pidMarker `
                -Build $ExpectedBuild -ExpectedStageRoot $StageRoot
            if ($state.State -eq 'running') {
                throw "Refusing cleanup: the PID marker reports the staged Frontier client is running (pid=$($record.pid))."
            }
        }
    }

    $processName = [IO.Path]::GetFileNameWithoutExtension($expectedExefile)
    foreach ($process in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
        try {
            $actualPath = $process.Path
        }
        catch {
            if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { continue }
            throw "Refusing cleanup because process $($process.Id) executable path cannot be verified."
        }
        if (-not $actualPath) {
            if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { continue }
            throw "Refusing cleanup because process $($process.Id) executable path cannot be verified."
        }
        if (Test-FrontierSamePath $actualPath $expectedExefile) {
            throw "Refusing cleanup: the exact staged Frontier executable is running (pid=$($process.Id))."
        }
    }
}

function Remove-OwnedStage {
    param(
        [string]$StageRoot,
        [int]$ExpectedBuild,
        [string]$ExpectedResFilesTarget
    )
    # A client can start while marker and layout validation is in progress.
    # Recheck at the last possible point before the first deletion.
    Assert-StagedClientNotRunning -StageRoot $StageRoot -ExpectedBuild $ExpectedBuild
    $marker = Get-ValidatedStageMarker -StageRoot $StageRoot `
        -ExpectedBuild $ExpectedBuild -ExpectedResFilesTarget $ExpectedResFilesTarget
    $resFilesPath = Join-Path $StageRoot 'ResFiles'
    $allowed = if ($marker.resFiles.mode -eq 'junction') { $resFilesPath } else { $null }
    if ($allowed) {
        Assert-StagedClientNotRunning -StageRoot $StageRoot -ExpectedBuild $ExpectedBuild
        Remove-Item -LiteralPath $allowed -Force
    }
    Assert-NoUnexpectedReparsePoints -Root $StageRoot
    Assert-StagedClientNotRunning -StageRoot $StageRoot -ExpectedBuild $ExpectedBuild
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
}

Assert-NoReparsePathChain -Path $StagingBase
$client = Invoke-FrontierDiscovery -RepoRoot $RepoRoot -SourceRoot $SourceRoot -Build $Build
$Build = [int]$client.metadata.build
$SourceBuild = [IO.Path]::GetFullPath([string]$client.buildRoot)
$SourceResFiles = [IO.Path]::GetFullPath([string]$client.resFilesRoot)
$NativeBlue = [string]$client.nativeBlueName
$StageRoot = [IO.Path]::GetFullPath((Join-Path $StagingBase ([string]$Build)))
$MarkerPath = Join-Path $StageRoot '.evejs-frontier-stage.json'
Assert-NoReparsePathChain -Path $StageRoot
$stageExists = Test-Path -LiteralPath $StageRoot
if ($stageExists -and -not (Test-Path -LiteralPath $StageRoot -PathType Container)) {
    throw "Frontier stage path exists but is not a directory: $StageRoot"
}
$existingMarker = $null
if ($stageExists) {
    $existingMarker = Get-ValidatedStageMarker -StageRoot $StageRoot `
        -ExpectedBuild $Build -ExpectedResFilesTarget $SourceResFiles
}

if ($Status) {
    Write-Output "[evejs-frontier] Installed build: $Build ($SourceBuild)"
    if (-not $existingMarker) {
        Write-Output "[evejs-frontier] Stage: missing ($StageRoot)"
        return
    }
    Write-Output "[evejs-frontier] Stage: $($existingMarker.patchState) ($StageRoot)"
    Write-Output "[evejs-frontier] ResFiles: $($existingMarker.resFiles.mode)"
    return
}

if ($DryRun) {
    $retail = Get-RetailHashes -BuildRoot $SourceBuild -NativeBlue $NativeBlue
    Write-Output "[evejs-frontier] Dry run: validated $($retail.Count) official-client hashes."
    Write-Output "[evejs-frontier] Dry run: would stage build $Build at $StageRoot"
    Write-Output "[evejs-frontier] Dry run: ResFiles mode $(if ($CopyResFiles) { 'copy' } else { 'junction' })"
    Write-Output "[evejs-frontier] Dry run: patch=$(if ($NoPatch) { 'disabled' } else { 'exact-build transaction' })"
    return
}

if ($Clean -and $existingMarker) {
    Assert-StagedClientNotRunning -StageRoot $StageRoot -ExpectedBuild $Build
    Remove-OwnedStage -StageRoot $StageRoot -ExpectedBuild $Build `
        -ExpectedResFilesTarget $SourceResFiles
    Write-Host "[evejs-frontier] Removed marker-owned stage: $StageRoot"
    $existingMarker = $null
}

if ($existingMarker) {
    $marker = Get-ValidatedStageMarker -StageRoot $StageRoot `
        -ExpectedBuild $Build -ExpectedResFilesTarget $SourceResFiles
    if (-not (Test-FrontierSamePath $marker.sourceRoot $SourceBuild)) {
        throw 'Existing stage was copied from another official client root. Use -Clean after review.'
    }
    $before = $marker.retailHashesBefore
    foreach ($property in $before.PSObject.Properties) {
        $actual = Get-FrontierSha256 (Join-Path $SourceBuild $property.Name.Replace('/', '\'))
        if ($actual -ne [string]$property.Value) {
            throw "Official client changed since staging: $($property.Name)"
        }
    }
    if ($marker.patchState -eq 'complete') {
        $null = Get-ValidatedStageMarker -StageRoot $StageRoot `
            -ExpectedBuild $Build -ExpectedResFilesTarget $SourceResFiles
        & (Join-Path $RepoRoot 'PatchFrontierClientTrust.ps1') -StagedRoot $StageRoot -Check
        return
    }
} else {
    Assert-NoReparsePathChain -Path $StagingBase
    New-Item -ItemType Directory -Path $StagingBase -Force | Out-Null
    Assert-NoReparsePathChain -Path $StagingBase -RequireLeafDirectory
    $initializing = [IO.Path]::GetFullPath((Join-Path $StagingBase (
        ".$Build.initializing-$([guid]::NewGuid().ToString('N'))")))
    if (-not (Test-FrontierContainedPath $initializing $StagingBase)) {
        throw "Unsafe stage initialization path: $initializing"
    }
    $retailBefore = Get-RetailHashes -BuildRoot $SourceBuild -NativeBlue $NativeBlue
    try {
        New-Item -ItemType Directory -Path $initializing | Out-Null
        Write-Host "[evejs-frontier] Copying the immutable build tree into $StageRoot ..."
        & robocopy.exe $SourceBuild $initializing /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP /NJH /NJS
        $copyExit = $LASTEXITCODE
        if ($copyExit -gt 7) { throw "robocopy failed with exit code $copyExit" }

        $resFilesPath = Join-Path $initializing 'ResFiles'
        if ($CopyResFiles) {
            New-Item -ItemType Directory -Path $resFilesPath | Out-Null
            Write-Host '[evejs-frontier] Copying the complete ResFiles cache (this can take a while) ...'
            & robocopy.exe $SourceResFiles $resFilesPath /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP /NJH /NJS
            if ($LASTEXITCODE -gt 7) { throw "ResFiles robocopy failed with exit code $LASTEXITCODE" }
            $resFiles = [ordered]@{
                mode = 'copy'
                path = (Join-Path $StageRoot 'ResFiles')
                sourceTarget = $SourceResFiles
            }
        } else {
            New-Item -ItemType Junction -Path $resFilesPath -Target $SourceResFiles | Out-Null
            $resFiles = [ordered]@{
                mode = 'junction'
                path = (Join-Path $StageRoot 'ResFiles')
                target = $SourceResFiles
                sharedWritableCache = $true
            }
        }

        [IO.File]::WriteAllText(
            (Join-Path $initializing 'common.ini'),
            "; Generated by EveJS-Frontier StageFrontierClient.ps1`r`n[main]`r`ncryptoPack = Placebo`r`n",
            [Text.UTF8Encoding]::new($false)
        )
        foreach ($property in $retailBefore.GetEnumerator()) {
            $stagedPath = Join-Path $initializing $property.Key.Replace('/', '\')
            $stagedHash = Get-FrontierSha256 $stagedPath
            if ($stagedHash -ne $property.Value) {
                throw "Staged copy hash mismatch before mutation: $($property.Key)"
            }
        }
        $retailAfterStage = Get-RetailHashes -BuildRoot $SourceBuild -NativeBlue $NativeBlue
        foreach ($property in $retailBefore.GetEnumerator()) {
            if ($retailAfterStage[$property.Key] -ne $property.Value) {
                throw "Official client changed during staging: $($property.Key)"
            }
        }
        $originalHashes = [ordered]@{}
        foreach ($property in $retailBefore.GetEnumerator()) {
            $originalHashes[$property.Key] = $property.Value
        }
        $marker = [ordered]@{
            format = 'evejs-frontier-stage-v2'
            platform = 'windows'
            build = $Build
            stagePath = $StageRoot
            stagingBase = $StagingBase
            sourceRoot = $SourceBuild
            sourceClientRoot = [string]$client.clientRoot
            sourceChannel = [string]$client.channel
            nativeBlue = $NativeBlue
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            originalHashes = $originalHashes
            currentHashes = $originalHashes
            retailHashesBefore = $retailBefore
            retailHashesAfterStage = $retailAfterStage
            fileStates = [ordered]@{
                nativeBlue = 'exact-source'
                codeCcp = 'exact-source'
                manifest = 'retail'
                caBundles = 'retail'
                exefile = 'authenticode-retail'
            }
            exactPatchProfileBuilds = @($Build)
            enabledFeatures = @(
                'station-docking',
                'frontier-creation',
                'smart-storage',
                'heavy-gate',
                'hud-map'
            )
            caFingerprintSha256 = $null
            clientPatchBackup = $null
            resFiles = $resFiles
            bootCryptoPack = 'Placebo'
            patchState = 'unpatched'
        }
        Write-FrontierJsonAtomic -Path (Join-Path $initializing '.evejs-frontier-stage.json') `
            -Value $marker
        $temporaryResFiles = Join-Path $initializing 'ResFiles'
        if ($resFiles.mode -eq 'junction') {
            Assert-NoUnexpectedReparsePoints -Root $initializing `
                -AllowedResFiles $temporaryResFiles
            Assert-JunctionTarget -JunctionPath $temporaryResFiles `
                -ExpectedTarget $SourceResFiles
        } else {
            Assert-NoUnexpectedReparsePoints -Root $initializing
        }
        Assert-NoReparsePathChain -Path $StagingBase -RequireLeafDirectory
        Assert-NoReparsePathChain -Path $StageRoot
        if (Test-Path -LiteralPath $StageRoot) {
            throw "Refusing to replace a stage path that appeared during initialization: $StageRoot"
        }
        Move-Item -LiteralPath $initializing -Destination $StageRoot
    }
    catch {
        if (Test-Path -LiteralPath $initializing) {
            $tempRes = Join-Path $initializing 'ResFiles'
            if (Test-Path -LiteralPath $tempRes -PathType Container) {
                $tempItem = Get-Item -LiteralPath $tempRes -Force
                if ($tempItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    Assert-JunctionTarget -JunctionPath $tempRes -ExpectedTarget $SourceResFiles
                    Remove-Item -LiteralPath $tempRes -Force
                }
            }
            Assert-NoUnexpectedReparsePoints -Root $initializing
            Remove-Item -LiteralPath $initializing -Recurse -Force
        }
        throw
    }
}

if (-not $NoPatch) {
    $null = Get-ValidatedStageMarker -StageRoot $StageRoot `
        -ExpectedBuild $Build -ExpectedResFilesTarget $SourceResFiles
    & (Join-Path $RepoRoot 'PatchFrontierClientTrust.ps1') -StagedRoot $StageRoot
} else {
    Write-Output "[evejs-frontier] Unpatched isolated stage: $StageRoot"
}
