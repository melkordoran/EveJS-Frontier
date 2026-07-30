param(
  [string]$ClientPath,
  [switch]$ForceRebuildGatewayCert,
  [switch]$SkipRootStore,
  [switch]$SkipClientBundles
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$caCertPath = Join-Path $repoRoot "server\certs\xmpp-ca-cert.pem"
$caKeyPath = Join-Path $repoRoot "server\certs\xmpp-ca-key.pem"
$builderScriptPath = Join-Path $PSScriptRoot "build-gateway-cert.js"
$xmppCertDir = Join-Path $repoRoot "server\certs"
$xmppCertPath = Join-Path $xmppCertDir "xmpp-dev-cert.pem"
$xmppKeyPath = Join-Path $xmppCertDir "xmpp-dev-key.pem"
$gatewayCertDir = Join-Path $repoRoot "server\src\_secondary\express\certs"
$gatewayCertPath = Join-Path $gatewayCertDir "gateway-dev-cert.pem"
$gatewayKeyPath = Join-Path $gatewayCertDir "gateway-dev-key.pem"
$gatewayFriendlyName = "eve.js Public Gateway TLS"
$gatewaySubject = "CN=dev-public-gateway.evetech.net"

# Must stay identical to LOCAL_TLS_DNS_ALT_NAMES in
# server\src\_secondary\express\localTlsCertificate.js. The server checks the
# gateway leaf against that exact set on every boot and silently rebuilds the
# certificate when it does not match, which would throw away the leaf this
# script just built and re-signed into the client bundles.
$gatewayDnsNames = @(
  "app.launchdarkly.com",
  "clientstream.launchdarkly.com",
  "clientsdk.launchdarkly.com",
  "dev-public-gateway.evetech.net",
  "events.launchdarkly.com",
  "public-gateway.evetech.net",
  "stream.launchdarkly.com",
  "localhost"
)
$gatewayIpNames = @("127.0.0.1")

function Write-Step {
  param([string]$Message)

  Write-Host "[eve.js] $Message" -ForegroundColor Cyan
}

function Get-NodeCommand {
  $nodeCommand = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeCommand) {
    $nodeCommand = (Get-Command node -ErrorAction SilentlyContinue).Source
  }
  if (-not $nodeCommand) {
    throw "Node.js was not found on PATH. Install the LTS release from https://nodejs.org and run this again."
  }

  return $nodeCommand
}

function Get-NpmCommand {
  foreach ($candidate in @("npm.cmd", "npm")) {
    $npmCommand = (Get-Command $candidate -ErrorAction SilentlyContinue).Source
    if ($npmCommand) {
      return $npmCommand
    }
  }

  return $null
}

function Test-NodeForgeAvailable {
  $nodeCommand = Get-NodeCommand
  # $ErrorActionPreference is Stop for this script, which would turn the probe's
  # stderr output into a terminating error. A failed require is the expected
  # answer here, not a crash.
  $ErrorActionPreference = "Continue"
  Push-Location $repoRoot
  try {
    & $nodeCommand -e "require('node-forge')" 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

function Ensure-CertificateToolingDependencies {
  # build-gateway-cert.js needs node-forge. On a fresh checkout nothing has run
  # npm yet, and the launcher that installs packages (StartServer.bat) used to
  # refuse to run until this wizard had already written EvEJSConfig.bat -- so
  # certificate generation could never happen first. Install the root packages
  # here instead of depending on that ordering. Root install is pure JavaScript;
  # it does not build the native server modules.
  if (Test-NodeForgeAvailable) {
    return
  }

  $npmCommand = Get-NpmCommand
  if (-not $npmCommand) {
    throw "npm was not found on PATH. Install Node.js LTS from https://nodejs.org and run this again."
  }

  Write-Step "Installing certificate tooling packages (first run only) ..."
  # npm writes progress and warnings to stderr even on success, so this must not
  # run with $ErrorActionPreference = Stop.
  $ErrorActionPreference = "Continue"
  Push-Location $repoRoot
  try {
    # "$_" keeps npm's stderr warnings from being rendered as red PowerShell
    # error blocks, which look like a crash during a normal install.
    if (Test-Path (Join-Path $repoRoot "package-lock.json")) {
      & $npmCommand ci --no-audit --no-fund 2>&1 | ForEach-Object { "$_" } | Out-Host
    } else {
      & $npmCommand install --no-audit --no-fund 2>&1 | ForEach-Object { "$_" } | Out-Host
    }
    $npmExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($npmExit -ne 0) {
    throw "npm install failed with exit code $npmExit in $repoRoot. Check your Internet connection and npm configuration."
  }
  if (-not (Test-NodeForgeAvailable)) {
    throw "node-forge is still missing after installing packages in $repoRoot."
  }

  Write-Step "Certificate tooling packages installed."
}

function Ensure-LocalCertificateFiles {
  # The chat certificate is issued for "localhost" regardless of where the
  # server actually listens. The EVE client validates this connection against
  # its certifi CA bundle only and does not check the hostname (see
  # ensureXmppTlsCertificate in server\src\_secondary\express\localTlsCertificate.js),
  # so this stays correct for a LAN or multiplayer host. The server reuses an
  # existing certificate and only generates one when these files are absent.
  New-Item -ItemType Directory -Force -Path $xmppCertDir | Out-Null

  if (Test-LeafNeedsRebuild `
    -CertPath $xmppCertPath `
    -KeyPath $xmppKeyPath `
    -RequiredDnsNames @("localhost")) {
    Invoke-CertificateBuilder `
      -OutCertPath $xmppCertPath `
      -OutKeyPath $xmppKeyPath `
      -CommonName "localhost" `
      -DnsNames @("localhost") `
      -IpNames @("127.0.0.1")
    Write-Step "Built CA-signed XMPP TLS cert under $xmppCertDir"
  }
}

function Resolve-ConfiguredClientPath {
  param([string]$ConfiguredPath)

  $candidates = @()
  if ($ConfiguredPath) {
    $candidates += $ConfiguredPath
  }
  if ($env:EVEJS_CLIENT_PATH) {
    $candidates += $env:EVEJS_CLIENT_PATH
  }
  $repoClientPath = Join-Path $repoRoot "client\EVE\tq"
  if (Test-Path $repoClientPath) {
    $candidates += $repoClientPath
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path -Path $candidate).Path
    }
  }

  return $null
}

function Get-ClientBundlePaths {
  param([string]$ResolvedClientPath)

  if (-not $ResolvedClientPath) {
    return @()
  }

  $fixedPaths = @(
    (Join-Path $ResolvedClientPath "bin64\cacert.pem"),
    (Join-Path $ResolvedClientPath "bin64\packages\certifi\cacert.pem"),
    (Join-Path $ResolvedClientPath "bin\cacert.pem"),
    (Join-Path $ResolvedClientPath "bin\packages\certifi\cacert.pem")
  ) | Where-Object { Test-Path $_ }

  $recursivePaths = @(Get-ChildItem -LiteralPath $ResolvedClientPath -Recurse -Filter "cacert.pem" -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName })

  return @($fixedPaths + $recursivePaths |
    Where-Object { $_ } |
    ForEach-Object { (Resolve-Path -LiteralPath $_).Path } |
    Sort-Object -Unique)
}

function Remove-PemBlockFromContent {
  param(
    [string]$Content,
    [string]$PemBlock
  )

  if (-not $PemBlock) {
    return $Content
  }

  $trimmedPem = $PemBlock.Trim()
  if (-not $trimmedPem) {
    return $Content
  }

  return ($Content -replace [regex]::Escape($trimmedPem), "").TrimEnd() + "`r`n"
}

function Convert-PemBlockToCertificate {
  param([string]$PemBlock)

  $base64 = ($PemBlock `
    -replace "-----BEGIN CERTIFICATE-----", "" `
    -replace "-----END CERTIFICATE-----", "" `
    -replace "\s", "")

  if (-not $base64) {
    return $null
  }

  try {
    $bytes = [Convert]::FromBase64String($base64)
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$bytes)
  } catch {
    return $null
  }
}

function Remove-EvEJSLocalCertificateBlocksFromContent {
  param(
    [string]$Content,
    [string]$CurrentCaThumbprint
  )

  if (-not $Content) {
    return ""
  }

  $regex = New-Object System.Text.RegularExpressions.Regex(
    "-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----",
    [System.Text.RegularExpressions.RegexOptions]::Multiline
  )

  $updated = $regex.Replace(
    $Content,
    [System.Text.RegularExpressions.MatchEvaluator]{
      param($match)

      $cert = Convert-PemBlockToCertificate -PemBlock $match.Value
      if ($cert) {
        $subject = [string]$cert.Subject
        $issuer = [string]$cert.Issuer
        $thumbprint = [string]$cert.Thumbprint
        if (
          $subject -like "*EvEJS Local*" -or
          $issuer -like "*EvEJS Local*" -or
          $subject -like "*eve.js Public Gateway TLS*" -or
          $issuer -like "*eve.js Public Gateway TLS*"
        ) {
          if ($CurrentCaThumbprint -and $thumbprint -eq $CurrentCaThumbprint) {
            return $match.Value
          }
          return ""
        }
      }

      return $match.Value
    }
  )

  return $updated.TrimEnd() + "`r`n"
}

function Ensure-PemBundleContainsCa {
  param(
    [string]$BundlePath,
    [string]$PemCaPath,
    [string[]]$PemBlocksToRemove = @()
  )

  $bundleRaw = Get-Content -LiteralPath $BundlePath -Raw
  foreach ($pemBlock in $PemBlocksToRemove) {
    $bundleRaw = Remove-PemBlockFromContent -Content $bundleRaw -PemBlock $pemBlock
  }

  $caRaw = (Get-Content -LiteralPath $PemCaPath -Raw).Trim()
  $caCert = Get-PfxCertificate -FilePath $PemCaPath
  $bundleRaw = Remove-EvEJSLocalCertificateBlocksFromContent `
    -Content $bundleRaw `
    -CurrentCaThumbprint $caCert.Thumbprint

  if ($bundleRaw.Contains($caRaw)) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($BundlePath, $bundleRaw, $encoding)
    Write-Step "CA already present in $BundlePath"
    return
  }

  $updated = $bundleRaw.TrimEnd() + "`r`n`r`n" + $caRaw + "`r`n"
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($BundlePath, $updated, $encoding)
  $verifyRaw = Get-Content -LiteralPath $BundlePath -Raw
  if (-not $verifyRaw.Contains($caRaw)) {
    throw "Failed to verify EvEJS CA inside $BundlePath after writing."
  }
  Write-Step "Appended CA to $BundlePath"
}

function Ensure-RootTrust {
  param([string]$PemPath)

  $cert = Get-PfxCertificate -FilePath $PemPath
  $staleCerts = @(Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object {
    (
      $_.Subject -like "*EvEJS Local*" -or
      $_.Issuer -like "*EvEJS Local*"
    ) -and $_.Thumbprint -ne $cert.Thumbprint
  })

  foreach ($staleCert in $staleCerts) {
    Remove-Item -Path (Join-Path "Cert:\CurrentUser\Root" $staleCert.Thumbprint) -ErrorAction SilentlyContinue
  }
  if ($staleCerts.Count -gt 0) {
    Write-Step "Removed $($staleCerts.Count) stale EvEJS CA certificate(s) from CurrentUser\Root."
  }

  $existing = Get-ChildItem Cert:\CurrentUser\Root | Where-Object {
    $_.Thumbprint -eq $cert.Thumbprint
  }

  if ($existing) {
    Write-Step "CA already trusted in CurrentUser\Root."
    return
  }

  Import-Certificate -FilePath $PemPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  Write-Step "Installed CA into CurrentUser\Root."
}

function Remove-ExistingGatewayCerts {
  $stores = @("Cert:\CurrentUser\My", "Cert:\CurrentUser\Root")
  foreach ($store in $stores) {
    $existing = Get-ChildItem $store | Where-Object {
      $_.FriendlyName -eq $gatewayFriendlyName -or $_.Subject -eq $gatewaySubject
    }

    foreach ($cert in $existing) {
      Remove-Item -Path (Join-Path $store $cert.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
    }
  }
}

function Test-LeafNeedsRebuild {
  param(
    [string]$CertPath,
    [string]$KeyPath,
    [string[]]$RequiredDnsNames
  )

  if ((-not (Test-Path $CertPath)) -or (-not (Test-Path $KeyPath))) {
    return $true
  }
  if ((-not (Test-Path $caCertPath)) -or (-not (Test-Path $caKeyPath))) {
    return $true
  }

  try {
    $cert = Get-PfxCertificate -FilePath $CertPath
    $caCert = Get-PfxCertificate -FilePath $caCertPath
    if ([string]::Equals($cert.Subject, $cert.Issuer, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
    if (-not [string]::Equals($cert.Issuer, $caCert.Subject, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }

    $dnsNames = @($cert.DnsNameList | ForEach-Object { $_.Unicode.ToLowerInvariant() })
    foreach ($requiredName in $RequiredDnsNames) {
      if ($dnsNames -notcontains $requiredName) {
        return $true
      }
    }

    return $false
  } catch {
    return $true
  }
}

function Invoke-CertificateBuilder {
  param(
    [string]$OutCertPath,
    [string]$OutKeyPath,
    [string]$CommonName,
    [string[]]$DnsNames,
    [string[]]$IpNames
  )

  $nodeCommand = Get-NodeCommand
  # Let the exit-code check below report the failure instead of the raw stderr
  # stream becoming a terminating error first.
  $ErrorActionPreference = "Continue"
  & $nodeCommand $builderScriptPath `
    --ensure-ca `
    --ca-cert $caCertPath `
    --ca-key $caKeyPath `
    --common-name $CommonName `
    --dns ($DnsNames -join ",") `
    --ip ($IpNames -join ",") `
    --out-cert $OutCertPath `
    --out-key $OutKeyPath

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build local TLS certificate for $CommonName."
  }
}

function Build-GatewayCertificate {
  New-Item -ItemType Directory -Force -Path $gatewayCertDir | Out-Null

  $previousLeafPem = $null
  if (Test-Path $gatewayCertPath) {
    $previousLeafPem = (Get-Content -Path $gatewayCertPath -Raw).Trim()
  }

  if ($ForceRebuildGatewayCert) {
    Remove-ExistingGatewayCerts
    Remove-Item -Path $gatewayCertPath, $gatewayKeyPath -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-LeafNeedsRebuild `
    -CertPath $gatewayCertPath `
    -KeyPath $gatewayKeyPath `
    -RequiredDnsNames $gatewayDnsNames)) {
    Write-Step "Gateway TLS files already exist."
    return $previousLeafPem
  }

  Invoke-CertificateBuilder `
    -OutCertPath $gatewayCertPath `
    -OutKeyPath $gatewayKeyPath `
    -CommonName "dev-public-gateway.evetech.net" `
    -DnsNames $gatewayDnsNames `
    -IpNames $gatewayIpNames

  Write-Step "Built CA-signed public-gateway TLS cert under $gatewayCertDir"
  return $previousLeafPem
}

Ensure-CertificateToolingDependencies
Ensure-LocalCertificateFiles

if (-not (Test-Path $caCertPath)) {
  throw "Missing CA certificate at $caCertPath"
}

if (-not (Test-Path $caKeyPath)) {
  throw "Missing CA private key at $caKeyPath"
}

$oldLeafPem = Build-GatewayCertificate

if (-not $SkipRootStore) {
  Ensure-RootTrust -PemPath $caCertPath
}

if (-not $SkipClientBundles) {
  $resolvedClientPath = Resolve-ConfiguredClientPath -ConfiguredPath $ClientPath
  if (-not $resolvedClientPath) {
    throw "Client path was not found. Edit tools\ClientSETUP\scripts\EvEJSConfig.bat or pass -ClientPath."
  }

  $bundlePaths = Get-ClientBundlePaths -ResolvedClientPath $resolvedClientPath
  if (-not $bundlePaths) {
    throw "No client cacert.pem bundle was found under $resolvedClientPath"
  }

  $currentLeafPem = $null
  if (Test-Path $gatewayCertPath) {
    $currentLeafPem = (Get-Content -Path $gatewayCertPath -Raw).Trim()
  }

  foreach ($bundlePath in $bundlePaths) {
    Ensure-PemBundleContainsCa `
      -BundlePath $bundlePath `
      -PemCaPath $caCertPath `
      -PemBlocksToRemove @($oldLeafPem, $currentLeafPem)
  }
}

Write-Step "Chat and public-gateway certificates are ready."
