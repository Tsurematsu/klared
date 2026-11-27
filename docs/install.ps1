[CmdletBinding()]
param(
  [switch]$Force,
  [string]$Version = $env:KLARED_VERSION,
  [string]$InstallDir = $env:KLARED_INSTALL_DIR
)

$ErrorActionPreference = 'Stop'

$Repo = 'Tsurematsu/klared'
$BinName = 'klared.exe'
$AssetName = 'klared-win-x64.exe'

if ($env:KLARED_FORCE -eq '1' -or $env:KLARED_FORCE -eq 'true') {
  $Force = $true
}

function Write-Info($msg) { Write-Host "[i] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

if ([Environment]::Is64BitOperatingSystem -eq $false) {
  throw 'Arquitectura no soportada: klared requiere Windows de 64 bits (x64).'
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$TargetVersion = $Version
if ([string]::IsNullOrWhiteSpace($TargetVersion)) {
  Write-Info 'Consultando la última versión de klared en GitHub...'
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'klared-installer' }
    if ($release.tag_name) {
      $TargetVersion = [string]$release.tag_name
    }
  } catch {
    Write-Warn 'No se pudo consultar la API de GitHub; se descargará desde releases/latest.'
  }
}

if ([string]::IsNullOrWhiteSpace($TargetVersion)) {
  $TargetVersion = 'latest'
  $DownloadBase = "https://github.com/$Repo/releases/latest/download"
} else {
  $DownloadBase = "https://github.com/$Repo/releases/download/$TargetVersion"
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'klared'
}

$TargetBin = Join-Path $InstallDir $BinName
$VersionFile = Join-Path $InstallDir 'version.txt'
$InstalledVersion = ''
if (Test-Path $VersionFile) {
  $InstalledVersion = (Get-Content -Path $VersionFile -Raw).Trim()
}

if (-not $Force -and (Test-Path $TargetBin) -and $TargetVersion -ne 'latest' -and $InstalledVersion -eq $TargetVersion) {
  Write-Ok "klared ya está instalado y actualizado en la última versión ($TargetVersion) en $TargetBin"
  Write-Info 'Usa -Force (o $env:KLARED_FORCE="1") si deseas reinstalarlo.'
  return
}

if (Test-Path $TargetBin) {
  $prevLabel = if ($InstalledVersion) { $InstalledVersion } else { 'versión previa' }
  Write-Info "Actualizando klared ($prevLabel -> $TargetVersion) en $TargetBin..."
} else {
  Write-Info "Instalando klared ($TargetVersion) en $TargetBin..."
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("klared-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
  $TempBin = Join-Path $TempDir $AssetName
  $TempSums = Join-Path $TempDir 'SHA256SUMS.txt'
  $BinUrl = "$DownloadBase/$AssetName"
  $SumsUrl = "$DownloadBase/SHA256SUMS.txt"

  Write-Info "Descargando $AssetName..."
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -fL --progress-bar --retry 3 -o $TempBin $BinUrl
    if ($LASTEXITCODE -ne 0) {
      throw "Error descargando $BinUrl (curl.exe código $LASTEXITCODE)"
    }
  } else {
    Invoke-WebRequest -Uri $BinUrl -OutFile $TempBin -UseBasicParsing
  }

  $sumsDownloaded = $false
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      & curl.exe -fsSL --retry 2 -o $TempSums $SumsUrl
      if ($LASTEXITCODE -eq 0 -and (Test-Path $TempSums)) { $sumsDownloaded = $true }
    } else {
      Invoke-WebRequest -Uri $SumsUrl -OutFile $TempSums -UseBasicParsing
      $sumsDownloaded = $true
    }
  } catch {
    $sumsDownloaded = $false
  }

  if ($sumsDownloaded) {
    $expectedLine = Get-Content -Path $TempSums | Where-Object { $_ -match "(^|\s)\*?$([regex]::Escape($AssetName))$" } | Select-Object -First 1
    if ($expectedLine) {
      $expectedHash = ($expectedLine -split '\s+')[0].ToLowerInvariant()
      $actualHash = (Get-FileHash -Path $TempBin -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($expectedHash -ne $actualHash) {
        throw "Fallo de verificación SHA-256 (esperado: $expectedHash, obtenido: $actualHash)"
      }
      Write-Ok 'Integridad SHA-256 verificada correctamente.'
    }
  } else {
    Write-Warn 'No se encontró SHA256SUMS.txt en el release; omitiendo verificación de hash.'
  }

  Move-Item -Path $TempBin -Destination $TargetBin -Force
  if ($TargetVersion -ne 'latest') {
    Set-Content -Path $VersionFile -Value $TargetVersion -Encoding UTF8
  }
} finally {
  Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathEntries = @()
if ($UserPath) {
  $PathEntries = $UserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

if ($PathEntries -notcontains $InstallDir) {
  $NewUserPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
  $env:Path = "$env:Path;$InstallDir"
  Write-Ok "Se agregó $InstallDir al PATH de usuario (abre una nueva terminal si no se reconoce de inmediato)."
}

Write-Ok "klared $TargetVersion instalado correctamente en $TargetBin"

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  Write-Warn "No se detectó 'kubectl' en el PATH. Recuerda instalarlo y configurar tu kubeconfig antes de usar klared."
}

Write-Info "Ejecuta 'klared' para abrir la TUI (o 'klared --check' para validar conexión)."
Write-Info 'Para actualizar en el futuro, vuelve a ejecutar este mismo comando.'
