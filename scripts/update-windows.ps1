[CmdletBinding()]
param(
  [string]$ProjectPath = 'C:\netease-together-mcp',
  [string]$RepositoryZip = 'https://github.com/kui-2026/netease-together-mcp/archive/refs/heads/main.zip',
  [int]$Port = 3456,
  [string]$TunnelClientPath = 'C:\tunnel-client\tunnel-client.exe',
  [string]$TunnelProfile = 'netease'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-RequiredExecutable {
  param([string[]]$Candidates, [string]$DisplayName)

  foreach ($candidate in $Candidates) {
    if (-not $candidate) { continue }
    $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Source }
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  throw "$DisplayName was not found. Install Node.js 20 or newer first."
}

function Stop-McpServer {
  param([int]$ListenPort)

  $listeners = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($process.ProcessName -ne 'node') {
      throw "Port $ListenPort is used by $($process.ProcessName) (PID $($process.Id)); refusing to stop it."
    }
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
}

function Start-McpServer {
  param([string]$NodePath, [string]$WorkingDirectory, [int]$ListenPort)

  Start-Process -FilePath $NodePath `
    -ArgumentList 'src\server.js' `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput (Join-Path $WorkingDirectory 'mcp.log') `
    -RedirectStandardError (Join-Path $WorkingDirectory 'mcp-error.log')

  $healthUrl = "http://127.0.0.1:$ListenPort/health"
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 750
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
      if ($health.status -eq 'ok') { return $health }
    } catch {
      # The process may still be starting.
    }
  }

  $errorLog = Join-Path $WorkingDirectory 'mcp-error.log'
  $details = if (Test-Path -LiteralPath $errorLog) {
    (Get-Content -LiteralPath $errorLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
  } else {
    'No error log was created.'
  }
  throw "The updated MCP server did not become healthy.`n$details"
}

function Start-TunnelClient {
  param([string]$ExecutablePath, [string]$ProfileName, [string]$LogDirectory)

  if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Tunnel client not found: $ExecutablePath"
  }
  Start-Process -FilePath $ExecutablePath `
    -ArgumentList @('run', '--profile', $ProfileName) `
    -WorkingDirectory (Split-Path -Parent $ExecutablePath) `
    -RedirectStandardOutput (Join-Path $LogDirectory 'tunnel.log') `
    -RedirectStandardError (Join-Path $LogDirectory 'tunnel-error.log')
}

$projectFullPath = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$envFile = Join-Path $projectFullPath '.env'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempRoot = Join-Path $env:TEMP "netease-together-update-$timestamp"
$zipPath = Join-Path $tempRoot 'source.zip'
$extractPath = Join-Path $tempRoot 'source'
$backupPath = "$projectFullPath.backup-$timestamp"
$failedPath = "$projectFullPath.failed-$timestamp"
$switched = $false
$tunnelWasRunning = $false
$tunnelRestarted = $false

$nodePath = Get-RequiredExecutable -DisplayName 'node.exe' -Candidates @(
  'C:\Program Files\nodejs\node.exe',
  'node.exe'
)
$npmPath = Get-RequiredExecutable -DisplayName 'npm.cmd' -Candidates @(
  'C:\Program Files\nodejs\npm.cmd',
  'npm.cmd'
)

if (-not (Test-Path -LiteralPath $projectFullPath -PathType Container)) {
  throw "Project folder not found: $projectFullPath"
}
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw "Secrets file not found: $envFile. Update stopped to protect the NetEase login."
}

try {
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
  Write-Host '1/5 Downloading the latest release...'
  Invoke-WebRequest -Uri $RepositoryZip -OutFile $zipPath
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force

  $packageFile = Get-ChildItem -LiteralPath $extractPath -Filter package.json -File -Recurse |
    Select-Object -First 1
  if (-not $packageFile) { throw 'The downloaded archive does not contain package.json.' }
  $releasePath = $packageFile.Directory.FullName
  if (-not (Test-Path -LiteralPath (Join-Path $releasePath 'src\server.js') -PathType Leaf)) {
    throw 'The downloaded archive does not contain src\server.js.'
  }

  Copy-Item -LiteralPath $envFile -Destination (Join-Path $releasePath '.env') -Force

  Write-Host '2/5 Installing dependencies in a staging folder...'
  Push-Location $releasePath
  try {
    & $npmPath ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

    Write-Host '3/5 Running checks before deployment...'
    & $npmPath test
    if ($LASTEXITCODE -ne 0) { throw "Tests failed with exit code $LASTEXITCODE." }
    & $npmPath run check
    if ($LASTEXITCODE -ne 0) { throw "Syntax checks failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }

  Write-Host '4/5 Switching to the verified release...'
  $tunnelProcesses = @(Get-Process -Name 'tunnel-client' -ErrorAction SilentlyContinue)
  $tunnelWasRunning = $tunnelProcesses.Count -gt 0
  if ($tunnelWasRunning) {
    $tunnelProcesses | Stop-Process -Force
    $tunnelProcesses | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  }
  Stop-McpServer -ListenPort $Port
  Set-Location (Split-Path -Parent $projectFullPath)
  Move-Item -LiteralPath $projectFullPath -Destination $backupPath
  $switched = $true
  Move-Item -LiteralPath $releasePath -Destination $projectFullPath

  Write-Host '5/5 Starting the MCP server and checking health...'
  $health = Start-McpServer -NodePath $nodePath -WorkingDirectory $projectFullPath -ListenPort $Port
  if ($tunnelWasRunning) {
    Start-TunnelClient -ExecutablePath $TunnelClientPath -ProfileName $TunnelProfile -LogDirectory (Split-Path -Parent $TunnelClientPath)
    $tunnelRestarted = $true
  }
  Write-Host ''
  Write-Host "Update successful. MCP status: $($health.status); version: $($health.version)" -ForegroundColor Green
  Write-Host "Rollback copy kept at: $backupPath"
  Write-Host 'If tools were added or renamed, refresh wyy in ChatGPT plugin settings.'
} catch {
  $originalError = $_
  if ($switched) {
    Write-Warning 'The new release failed. Restoring the previous working version...'
    Stop-McpServer -ListenPort $Port
    if (Test-Path -LiteralPath $projectFullPath) {
      Move-Item -LiteralPath $projectFullPath -Destination $failedPath
    }
    if (Test-Path -LiteralPath $backupPath) {
      Move-Item -LiteralPath $backupPath -Destination $projectFullPath
      try {
        Start-McpServer -NodePath $nodePath -WorkingDirectory $projectFullPath -ListenPort $Port | Out-Null
        Write-Host 'Previous version restored and restarted.' -ForegroundColor Yellow
      } catch {
        Write-Warning "Rollback files were restored, but restart failed: $($_.Exception.Message)"
      }
    }
  }
  if ($tunnelWasRunning -and -not $tunnelRestarted) {
    try {
      Start-TunnelClient -ExecutablePath $TunnelClientPath -ProfileName $TunnelProfile -LogDirectory (Split-Path -Parent $TunnelClientPath)
      $tunnelRestarted = $true
    } catch {
      Write-Warning "Tunnel restart failed: $($_.Exception.Message)"
    }
  }
  throw $originalError
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
