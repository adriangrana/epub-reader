param(
  [string]$DeployDir = 'C:\www\luma'
)

$ErrorActionPreference = 'Stop'
$Port = 8787
$AppProcess = 'luma'
$TunnelProcess = 'luma-tunnel'
$SourceRoot = Split-Path -Parent $PSScriptRoot

function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "No se encontro '$Name' en PATH. Instala/configura $Name antes de desplegar."
  }
  return $command.Source
}

function Test-RunaraProcess([string]$Name, [string]$RunaraCommand) {
  & $RunaraCommand info $Name *> $null
  return $LASTEXITCODE -eq 0
}

function Ensure-RunaraDaemon([string]$RunaraCommand) {
  & $RunaraCommand daemon status *> $null
  if ($LASTEXITCODE -eq 0) { return }

  Write-Host 'Runara daemon no esta activo. Iniciandolo...'
  & $RunaraCommand daemon start
  if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo iniciar el daemon de Runara.'
  }
}

function Upsert-AppProcess([string]$RunaraCommand) {
  # Runara persiste el comando como texto y luego lo ejecuta mediante shell.
  # Usamos el nombre disponible en PATH en lugar de la ruta absoluta de node
  # porque una ruta como C:\Program Files\nodejs\node.exe se fragmenta al
  # pasar por el parser CLI de Runara.
  $command = 'node server/index.mjs'

  if (Test-RunaraProcess $AppProcess $RunaraCommand) {
    Write-Host "Actualizando proceso Runara '$AppProcess'..."
    & $RunaraCommand set $AppProcess --command $command --cwd $DeployDir --max-restarts 20 --restart-delay 2000 --min-uptime 2000 --autorestart --autostart
    if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar '$AppProcess'." }

    & $RunaraCommand restart $AppProcess
    if ($LASTEXITCODE -ne 0) { throw "No se pudo reiniciar '$AppProcess'." }
    return
  }

  Write-Host "Creando proceso Runara '$AppProcess'..."
  & $RunaraCommand run $command --name $AppProcess --cwd $DeployDir --max-restarts 20 --restart-delay 2000 --min-uptime 2000 --autostart
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear '$AppProcess'." }
}

function Ensure-TunnelProcess([string]$RunaraCommand) {
  # Igual que con node: cloudflared ya fue validado en PATH, por lo que no
  # guardamos su ruta absoluta dentro del comando persistido por Runara.
  $command = "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$Port"

  if (Test-RunaraProcess $TunnelProcess $RunaraCommand) {
    Write-Host "El proceso '$TunnelProcess' ya existe. Se conserva para no cambiar innecesariamente la URL temporal."
    & $RunaraCommand set $TunnelProcess --command $command --cwd $DeployDir --max-restarts 20 --restart-delay 3000 --min-uptime 3000 --autorestart --autostart
    if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar '$TunnelProcess'." }

    # start es intencionadamente preferible a restart: si ya esta ejecutandose,
    # mantenemos el Quick Tunnel existente y por tanto su URL actual.
    & $RunaraCommand start $TunnelProcess *> $null
    return
  }

  Write-Host "Creando Quick Tunnel de Cloudflare en Runara ('$TunnelProcess')..."
  & $RunaraCommand run $command --name $TunnelProcess --cwd $DeployDir --max-restarts 20 --restart-delay 3000 --min-uptime 3000 --autostart
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear '$TunnelProcess'." }
}

$runara = Require-Command 'runara'
Require-Command 'node' | Out-Null
Require-Command 'cloudflared' | Out-Null

$distSource = Join-Path $SourceRoot 'dist'
$serverSource = Join-Path $SourceRoot 'server'

if (-not (Test-Path $distSource)) {
  throw "No existe '$distSource'. Ejecuta npm run build antes del deploy."
}
if (-not (Test-Path $serverSource)) {
  throw "No existe '$serverSource'."
}

Write-Host "Desplegando Luma en $DeployDir..."
New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null

# Solo reemplazamos artefactos de aplicacion. data/ se conserva siempre.
$distTarget = Join-Path $DeployDir 'dist'
$serverTarget = Join-Path $DeployDir 'server'
if (Test-Path $distTarget) { Remove-Item $distTarget -Recurse -Force }
if (Test-Path $serverTarget) { Remove-Item $serverTarget -Recurse -Force }

Copy-Item -Path $distSource -Destination $DeployDir -Recurse -Force
Copy-Item -Path $serverSource -Destination $DeployDir -Recurse -Force
Copy-Item -Path (Join-Path $SourceRoot 'package.json') -Destination $DeployDir -Force
if (Test-Path (Join-Path $SourceRoot 'package-lock.json')) {
  Copy-Item -Path (Join-Path $SourceRoot 'package-lock.json') -Destination $DeployDir -Force
}

Ensure-RunaraDaemon $runara
Upsert-AppProcess $runara

Write-Host 'Comprobando healthcheck local...'
$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $healthy = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if (-not $healthy) {
  throw "Luma no respondio correctamente en http://127.0.0.1:$Port/api/health. Revisa: runara logs $AppProcess --err --lines 100"
}

Ensure-TunnelProcess $runara

Write-Host ''
Write-Host 'Deploy completado.' -ForegroundColor Green
Write-Host "Local:   http://127.0.0.1:$Port"
Write-Host "Datos:   $(Join-Path $DeployDir 'data')"
Write-Host "App:     runara info $AppProcess"
Write-Host "Tunnel:  runara info $TunnelProcess"
Write-Host 'URL CF:  make tunnel-logs'
