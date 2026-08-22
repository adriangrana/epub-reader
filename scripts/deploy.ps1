param(
  [string]$DeployDir = 'C:\www\luma'
)

$ErrorActionPreference = 'Stop'
$Port = 8787
$TtsPort = 8790
$AppProcess = 'luma'
$TtsProcess = 'luma-tts'
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
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = (& $RunaraCommand info $Name 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  if ($output -match '(?i)process\s+["'']?.+?["'']?\s+not\s+found' -or
      $output -match '(?i)process.*not found' -or
      $output -match '(?i)failed to .*process' -or
      $output -match '\[ERR\]') {
    return $false
  }

  return $exitCode -eq 0
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

function Create-Process([string]$RunaraCommand, [string]$Name, [string]$Command, [int]$RestartDelay = 2000) {
  Write-Host "Creando proceso Runara '$Name'..."
  & $RunaraCommand run $Command --name $Name --cwd $DeployDir --max-restarts 20 --restart-delay $RestartDelay --min-uptime 2000 --autostart
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear '$Name'." }
}

function Upsert-AppProcess([string]$RunaraCommand) {
  $command = 'node server/index.mjs'

  if (-not (Test-RunaraProcess $AppProcess $RunaraCommand)) {
    Create-Process $RunaraCommand $AppProcess $command
    return
  }

  Write-Host "Actualizando proceso Runara '$AppProcess'..."
  & $RunaraCommand set $AppProcess --command $command --cwd $DeployDir --max-restarts 20 --restart-delay 2000 --min-uptime 2000 --autorestart --autostart
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-RunaraProcess $AppProcess $RunaraCommand)) {
      Create-Process $RunaraCommand $AppProcess $command
      return
    }
    throw "No se pudo actualizar '$AppProcess'."
  }

  & $RunaraCommand restart $AppProcess
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-RunaraProcess $AppProcess $RunaraCommand)) {
      Create-Process $RunaraCommand $AppProcess $command
      return
    }
    throw "No se pudo reiniciar '$AppProcess'."
  }
}

function Upsert-TtsProcess([string]$RunaraCommand) {
  # run-tts.cmd contiene la ruta absoluta al Python del venv fuente. De esta
  # forma no copiamos el entorno de varios GB a C:\www y Runara solo persiste
  # un comando corto sin problemas de espacios o quoting.
  $command = 'run-tts.cmd'

  if (-not (Test-RunaraProcess $TtsProcess $RunaraCommand)) {
    Create-Process $RunaraCommand $TtsProcess $command 3000
    return
  }

  Write-Host "Actualizando proceso Runara '$TtsProcess'..."
  & $RunaraCommand set $TtsProcess --command $command --cwd $DeployDir --max-restarts 20 --restart-delay 3000 --min-uptime 2000 --autorestart --autostart
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-RunaraProcess $TtsProcess $RunaraCommand)) {
      Create-Process $RunaraCommand $TtsProcess $command 3000
      return
    }
    throw "No se pudo actualizar '$TtsProcess'."
  }

  & $RunaraCommand restart $TtsProcess
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-RunaraProcess $TtsProcess $RunaraCommand)) {
      Create-Process $RunaraCommand $TtsProcess $command 3000
      return
    }
    throw "No se pudo reiniciar '$TtsProcess'."
  }
}

function Create-TunnelProcess([string]$RunaraCommand, [string]$Command) {
  Write-Host "Creando Quick Tunnel de Cloudflare en Runara ('$TunnelProcess')..."
  & $RunaraCommand run $Command --name $TunnelProcess --cwd $DeployDir --max-restarts 20 --restart-delay 3000 --min-uptime 3000 --autostart
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear '$TunnelProcess'." }
}

function Ensure-TunnelProcess([string]$RunaraCommand) {
  $command = "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$Port"

  if (-not (Test-RunaraProcess $TunnelProcess $RunaraCommand)) {
    Create-TunnelProcess $RunaraCommand $command
    return
  }

  Write-Host "El proceso '$TunnelProcess' ya existe. Se conserva para no cambiar innecesariamente la URL temporal."
  & $RunaraCommand set $TunnelProcess --command $command --cwd $DeployDir --max-restarts 20 --restart-delay 3000 --min-uptime 3000 --autorestart --autostart
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-RunaraProcess $TunnelProcess $RunaraCommand)) {
      Create-TunnelProcess $RunaraCommand $command
      return
    }
    throw "No se pudo actualizar '$TunnelProcess'."
  }

  & $RunaraCommand start $TunnelProcess *> $null
}

function Wait-ForHealth([string]$Url, [string]$FailureMessage) {
  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) { throw $FailureMessage }
}

$runara = Require-Command 'runara'
Require-Command 'node' | Out-Null
Require-Command 'cloudflared' | Out-Null

$distSource = Join-Path $SourceRoot 'dist'
$serverSource = Join-Path $SourceRoot 'server'
$ttsSource = Join-Path $SourceRoot 'tts'
$ttsPython = Join-Path $SourceRoot '.venv-tts\Scripts\python.exe'
$davefxSource = Join-Path $ttsSource 'voices\davefx.mp3'

if (-not (Test-Path $distSource)) {
  throw "No existe '$distSource'. Ejecuta npm run build antes del deploy."
}
if (-not (Test-Path $serverSource)) { throw "No existe '$serverSource'." }
if (-not (Test-Path $ttsSource)) { throw "No existe '$ttsSource'." }
if (-not (Test-Path $ttsPython)) {
  throw "No existe '$ttsPython'. Debes conservar el entorno .venv-tts con Chatterbox instalado."
}
if (-not (Test-Path $davefxSource)) {
  throw "No existe '$davefxSource'. Guarda ahi la muestra DaveFX antes de desplegar."
}

Write-Host "Desplegando Luma en $DeployDir..."
New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null

# Solo reemplazamos artefactos de aplicacion. data/ se conserva siempre.
$distTarget = Join-Path $DeployDir 'dist'
$serverTarget = Join-Path $DeployDir 'server'
$ttsTarget = Join-Path $DeployDir 'tts'
if (Test-Path $distTarget) { Remove-Item $distTarget -Recurse -Force }
if (Test-Path $serverTarget) { Remove-Item $serverTarget -Recurse -Force }

Copy-Item -Path $distSource -Destination $DeployDir -Recurse -Force
Copy-Item -Path $serverSource -Destination $DeployDir -Recurse -Force
New-Item -ItemType Directory -Force -Path $ttsTarget | Out-Null
Copy-Item -Path (Join-Path $ttsSource '*') -Destination $ttsTarget -Recurse -Force
Copy-Item -Path (Join-Path $SourceRoot 'package.json') -Destination $DeployDir -Force
if (Test-Path (Join-Path $SourceRoot 'package-lock.json')) {
  Copy-Item -Path (Join-Path $SourceRoot 'package-lock.json') -Destination $DeployDir -Force
}

# Wrapper estable para Runara. El servicio ejecutado vive en C:\www\luma,
# por lo que su cache queda en C:\www\luma\data\narration y se preserva entre deploys.
$ttsRunner = Join-Path $DeployDir 'run-tts.cmd'
$runnerContent = "@echo off`r`n`"$ttsPython`" tts\service.py`r`n"
Set-Content -Path $ttsRunner -Value $runnerContent -Encoding ASCII

Ensure-RunaraDaemon $runara
Upsert-TtsProcess $runara
Upsert-AppProcess $runara

Write-Host 'Comprobando narrador IA local...'
Wait-ForHealth "http://127.0.0.1:$TtsPort/health" "Luma TTS no respondio en http://127.0.0.1:$TtsPort/health. Revisa: runara logs $TtsProcess --err --lines 100"

Write-Host 'Comprobando healthcheck de Luma...'
Wait-ForHealth "http://127.0.0.1:$Port/api/health" "Luma no respondio correctamente en http://127.0.0.1:$Port/api/health. Revisa: runara logs $AppProcess --err --lines 100"

Ensure-TunnelProcess $runara

Write-Host ''
Write-Host 'Deploy completado.' -ForegroundColor Green
Write-Host "Local:    http://127.0.0.1:$Port"
Write-Host "TTS:      http://127.0.0.1:$TtsPort (solo localhost)"
Write-Host "Datos:    $(Join-Path $DeployDir 'data')"
Write-Host "App:      runara info $AppProcess"
Write-Host "Narrador: runara info $TtsProcess"
Write-Host "Tunnel:   runara info $TunnelProcess"
Write-Host 'URL CF:   make tunnel-logs'
