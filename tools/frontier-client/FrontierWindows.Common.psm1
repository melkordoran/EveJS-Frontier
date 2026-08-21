Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FrontierNodePath {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) {
        return [IO.Path]::GetFullPath($command.Source)
    }

    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe'
    }
    if ($env:LOCALAPPDATA) {
        $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        if (Test-Path -LiteralPath $wingetRoot -PathType Container) {
            $candidates += Get-ChildItem -LiteralPath $wingetRoot -Directory `
                -Filter 'OpenJS.NodeJS.LTS_*' -ErrorAction SilentlyContinue |
                ForEach-Object {
                    Get-ChildItem -LiteralPath $_.FullName -Directory -Filter 'node-v*-win-x64' `
                        -ErrorAction SilentlyContinue |
                        ForEach-Object { Join-Path $_.FullName 'node.exe' }
                }
        }
    }
    $node = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $node) {
        throw 'Node.js 24 LTS x64 was not found. Install OpenJS.NodeJS.LTS and open a fresh PowerShell.'
    }
    return [IO.Path]::GetFullPath($node)
}

function Get-FrontierNpmPath {
    $node = Get-FrontierNodePath
    $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
        throw "npm.cmd was not found beside Node.js: $npm"
    }
    return $npm
}

function Get-FrontierPython312Path {
    param([string]$RepoRoot)

    if ($RepoRoot) {
        $venv = Join-Path $RepoRoot '_local\frontier-python312\Scripts\python.exe'
        if (Test-Path -LiteralPath $venv -PathType Leaf) {
            $version = & $venv -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
            if ($LASTEXITCODE -eq 0 -and $version.Trim() -eq '3.12') {
                return [IO.Path]::GetFullPath($venv)
            }
        }
    }

    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
    }
    $python = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $python) {
        $py = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($py) {
            $resolved = & $py.Source -3.12 -c 'import sys; print(sys.executable)'
            if ($LASTEXITCODE -eq 0 -and $resolved) {
                $python = $resolved.Trim()
            }
        }
    }
    if (-not $python -or -not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw 'CPython 3.12 x64 was not found. Install Python.Python.3.12 exactly.'
    }
    $facts = & $python -c 'import platform,sys; print(f"{sys.version_info.major}.{sys.version_info.minor}|{platform.architecture()[0]}")'
    if ($LASTEXITCODE -ne 0 -or $facts.Trim() -ne '3.12|64bit') {
        throw "The resolved interpreter is not CPython 3.12 x64: $python ($facts)"
    }
    return [IO.Path]::GetFullPath($python)
}

function Invoke-FrontierDiscovery {
    param(
        [Parameter(Mandatory)] [string]$RepoRoot,
        [string]$SourceRoot,
        [int]$Build
    )

    $node = Get-FrontierNodePath
    $script = Join-Path $RepoRoot 'tools\frontier-static\discover-frontier-client.mjs'
    $arguments = @($script, '--json')
    if ($SourceRoot) {
        $arguments += @('--client-root', [IO.Path]::GetFullPath($SourceRoot))
    }
    if ($Build -gt 0) {
        $arguments += @('--build', [string]$Build)
    }
    $json = & $node @arguments
    if ($LASTEXITCODE -ne 0 -or -not $json) {
        throw 'Frontier client discovery failed.'
    }
    try {
        return ($json -join [Environment]::NewLine) | ConvertFrom-Json
    }
    catch {
        throw "Frontier client discovery returned invalid JSON: $($_.Exception.Message)"
    }
}

function Get-FrontierSha256 {
    param([Parameter(Mandatory)] [string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-FrontierSamePath {
    param(
        [Parameter(Mandatory)] [string]$Left,
        [Parameter(Mandatory)] [string]$Right
    )
    return [string]::Equals(
        [IO.Path]::GetFullPath($Left).TrimEnd('\', '/'),
        [IO.Path]::GetFullPath($Right).TrimEnd('\', '/'),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Test-FrontierContainedPath {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Base
    )
    $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $resolvedBase = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
    return $resolvedPath.StartsWith(
        $resolvedBase + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Read-FrontierStageMarker {
    param(
        [Parameter(Mandatory)] [string]$StageRoot,
        [string]$ExpectedBase,
        [int]$ExpectedBuild
    )
    $resolvedStage = [IO.Path]::GetFullPath($StageRoot)
    $markerPath = Join-Path $resolvedStage '.evejs-frontier-stage.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "Refusing an unrecognized Frontier stage without its marker: $resolvedStage"
    }
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Frontier stage marker is malformed: $markerPath"
    }
    if ($marker.format -ne 'evejs-frontier-stage-v2' -or $marker.platform -ne 'windows') {
        throw "Frontier stage marker format is unsupported: $markerPath"
    }
    $build = [int]$marker.build
    if ($build -le 0 -or [IO.Path]::GetFileName($resolvedStage) -ne [string]$build) {
        throw 'Frontier stage is not a marker-owned, build-numbered path.'
    }
    $base = [IO.Path]::GetFullPath([string]$marker.stagingBase)
    if (-not (Test-FrontierSamePath $marker.stagePath $resolvedStage) -or
        -not (Test-FrontierSamePath (Split-Path -Parent $resolvedStage) $base) -or
        -not (Test-FrontierContainedPath $resolvedStage $base)) {
        throw 'Frontier stage marker ownership or containment check failed.'
    }
    if ($ExpectedBase -and -not (Test-FrontierSamePath $ExpectedBase $base)) {
        throw 'Frontier stage marker belongs to another staging base.'
    }
    if ($ExpectedBuild -gt 0 -and $build -ne $ExpectedBuild) {
        throw "Frontier stage marker belongs to build $build, not $ExpectedBuild."
    }
    return $marker
}

function Write-FrontierJsonAtomic {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [object]$Value
    )
    $parent = Split-Path -Parent $Path
    $temporary = Join-Path $parent ('.{0}.tmp-{1}-{2}' -f
        [IO.Path]::GetFileName($Path), $PID, [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Read-FrontierClientProcessMarker {
    param(
        [Parameter(Mandatory)] [string]$MarkerPath,
        [Parameter(Mandatory)] [int]$Build,
        [string]$ExpectedStageRoot
    )

    $resolvedMarker = [IO.Path]::GetFullPath($MarkerPath)
    if (-not (Test-Path -LiteralPath $resolvedMarker -PathType Leaf)) {
        return $null
    }
    try {
        $marker = Get-Content -LiteralPath $resolvedMarker -Raw | ConvertFrom-Json
    }
    catch {
        throw "Client PID marker is malformed: $resolvedMarker"
    }

    $required = @(
        'format', 'build', 'stageRoot', 'exefile', 'pid', 'processStartTimeUtcTicks'
    )
    $present = @($marker.PSObject.Properties.Name)
    $missing = @($required | Where-Object { $present -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw "Client PID marker is missing required field(s): $($missing -join ', ')"
    }

    try {
        $markerStage = [IO.Path]::GetFullPath([string]$marker.stageRoot)
        $markerExefile = [IO.Path]::GetFullPath([string]$marker.exefile)
        $markerBuild = [int]$marker.build
        $markerPid = [int64]$marker.pid
        $markerStartTicks = [int64]$marker.processStartTimeUtcTicks
    }
    catch {
        throw "Client PID marker contains an invalid path or numeric field: $resolvedMarker"
    }

    if ($marker.format -ne 'evejs-frontier-client-process-v1' -or
        $markerBuild -ne $Build -or
        [IO.Path]::GetFileName($markerStage.TrimEnd('\', '/')) -ne [string]$Build -or
        -not (Test-FrontierSamePath $markerExefile (Join-Path $markerStage 'bin64\exefile.exe')) -or
        $markerPid -le 0 -or
        $markerStartTicks -le 0) {
        throw "Client PID marker is not an exact build-owned process record: $resolvedMarker"
    }
    if ($ExpectedStageRoot -and
        -not (Test-FrontierSamePath $markerStage ([IO.Path]::GetFullPath($ExpectedStageRoot)))) {
        throw "Client PID marker belongs to another staged root: $resolvedMarker"
    }
    return $marker
}

function Get-FrontierClientProcessState {
    param(
        [Parameter(Mandatory)] [string]$MarkerPath,
        [Parameter(Mandatory)] [int]$Build,
        [string]$ExpectedStageRoot
    )

    $marker = Read-FrontierClientProcessMarker -MarkerPath $MarkerPath -Build $Build `
        -ExpectedStageRoot $ExpectedStageRoot
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
        throw "Cannot verify client PID $($marker.pid): $($_.Exception.Message)"
    }
    if (-not (Test-FrontierSamePath $actualPath ([string]$marker.exefile)) -or
        [int64]$actualStartTicks -ne [int64]$marker.processStartTimeUtcTicks) {
        throw "PID $($marker.pid) is not the marker-owned staged Frontier client."
    }
    return [pscustomobject]@{ State = 'running'; Marker = $marker; Process = $process }
}

function Set-FrontierPrivateFileAcl {
    param([Parameter(Mandatory)] [string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Private file is missing: $Path"
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*$sid`:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not restrict inherited ACLs on private file: $Path"
    }
    $acl = Get-Acl -LiteralPath $Path
    $unexpected = @($acl.Access | Where-Object {
        if ($_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            return $false
        }
        try {
            $ruleSid = $_.IdentityReference.Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value
        }
        catch { return $true }
        return $ruleSid -ne $sid
    })
    foreach ($rule in $unexpected) {
        try {
            $ruleSid = $rule.IdentityReference.Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value
            & icacls.exe $Path /remove:g "*$ruleSid" | Out-Null
        }
        catch {
            throw "Could not remove an unexpected private-file ACL from ${Path}: $($rule.IdentityReference)"
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Could not remove an unexpected private-file ACL from ${Path}: $ruleSid"
        }
    }
    $remainingAllowed = @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
    })
    if ($remainingAllowed.Count -ne 1 -or
        $remainingAllowed[0].IdentityReference.Translate(
            [Security.Principal.SecurityIdentifier]).Value -ne $sid) {
        throw "Private-file ACL verification failed: $Path"
    }
}

function Write-FrontierPrivateLinesAtomic {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]]$Lines
    )

    foreach ($line in $Lines) {
        if ($line -match '[\r\n]') {
            throw 'Private-file lines must not contain embedded line breaks.'
        }
    }

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $resolvedPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (Test-Path -LiteralPath $resolvedPath) {
        $existing = Get-Item -LiteralPath $resolvedPath -Force
        if ($existing.PSIsContainer -or
            ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to replace a non-file or reparse-point credential path: $resolvedPath"
        }
    }

    $temporary = Join-Path $parent ('.{0}.tmp-{1}-{2}' -f
        [IO.Path]::GetFileName($resolvedPath), $PID, [guid]::NewGuid().ToString('N'))
    $stream = $null
    $moved = $false
    try {
        # The temporary file contains no credentials until inheritance has been removed.
        $stream = [IO.File]::Open(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        $stream.Dispose()
        $stream = $null
        Set-FrontierPrivateFileAcl -Path $temporary

        $payload = if ($Lines.Count -eq 0) {
            ''
        } else {
            ([string]::Join([Environment]::NewLine, $Lines) + [Environment]::NewLine)
        }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($payload)
        $stream = [IO.File]::Open(
            $temporary,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        $stream.SetLength(0)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if (-not [Linq.Enumerable]::SequenceEqual(
            [byte[]][IO.File]::ReadAllBytes($temporary), [byte[]]$bytes)) {
            throw "Private temporary-file verification failed: $temporary"
        }

        [IO.File]::Move($temporary, $resolvedPath, $true)
        $moved = $true
        Set-FrontierPrivateFileAcl -Path $resolvedPath
    }
    catch {
        $originalError = $_
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch {}
        }
        $cleanupFailures = [Collections.Generic.List[string]]::new()
        if (Test-Path -LiteralPath $temporary) {
            try { Remove-Item -LiteralPath $temporary -Force }
            catch { $cleanupFailures.Add($_.Exception.Message) }
        }
        if ($moved -and (Test-Path -LiteralPath $resolvedPath)) {
            try { Remove-Item -LiteralPath $resolvedPath -Force }
            catch { $cleanupFailures.Add($_.Exception.Message) }
        }
        if ($cleanupFailures.Count -gt 0) {
            throw "Private-file write failed ($($originalError.Exception.Message)); cleanup also failed: $($cleanupFailures -join '; ')"
        }
        throw $originalError
    }
    finally {
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch {}
        }
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Protect-FrontierLaunchArgument {
    param([Parameter(Mandatory)] [string]$Argument)
    if ($Argument -match '(?i)^/(ssoToken|refreshToken|LauncherData|deviceID|machineHash|journeyID)=') {
        return ($Argument -replace '=.*$', '=***')
    }
    if ($Argument -match '(?i)^exp=') {
        return 'exp=***'
    }
    return $Argument
}

Export-ModuleMember -Function @(
    'Get-FrontierNodePath',
    'Get-FrontierNpmPath',
    'Get-FrontierPython312Path',
    'Invoke-FrontierDiscovery',
    'Get-FrontierSha256',
    'Test-FrontierSamePath',
    'Test-FrontierContainedPath',
    'Read-FrontierStageMarker',
    'Write-FrontierJsonAtomic',
    'Read-FrontierClientProcessMarker',
    'Get-FrontierClientProcessState',
    'Set-FrontierPrivateFileAcl',
    'Write-FrontierPrivateLinesAtomic',
    'Protect-FrontierLaunchArgument'
)
