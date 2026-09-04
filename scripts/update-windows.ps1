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

function Stop-TunnelClientProfile {
  param([string]$ProfileName)

  $escapedProfile = [regex]::Escape($ProfileName)
  $matchingProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match "(?i)\\brun\\s+--profile\\s+$escapedProfile(?:\\s|$)" }
  )
  foreach ($process in $matchingProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }
}

function Start-TunnelClient {
  param([string]$ExecutablePath, [string]$ProfileName, [string]$LogDirectory)

  if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Tunnel client not found: $ExecutablePath"
  }

  $process = Start-Process -FilePath $ExecutablePath `
    -ArgumentList @('run', '--profile', $ProfileName) `
    -WorkingDirectory (Split-Path -Parent $ExecutablePath) `
    -RedirectStandardOutput (Join-Path $LogDirectory "$ProfileName-tunnel.log") `
    -RedirectStandardError (Join-Path $LogDirectory "$ProfileName-tunnel-error.log") `
    -PassThru

  Start-Sleep -Seconds 2
  if ($process.HasExited) {
    $errorLog = Join-Path $LogDirectory "$ProfileName-tunnel-error.log"
    $details = if (Test-Path -LiteralPath $errorLog) {
      (Get-Content -LiteralPath $errorLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else {
      'No tunnel error log was created.'
    }
    # A running client owns this profile's health listener. That client will
    # reconnect to the restarted MCP server, so it is safe and preferable to keep it.
    if ($details -match 'listen tcp .*: bind: Only one usage of each socket address') {
      Write-Host "Tunnel profile '$ProfileName' is already running; keeping the existing client." -ForegroundColor Yellow
      return $null
    }
    throw "Tunnel profile '$ProfileName' exited during startup.`n$details"
  }
  return $process
}

$projectFullPath = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$envFile = Join-Path $projectFullPath '.env'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempRoot = Join-Path $env:TEMP "netease-together-update-$timestamp"
$zipPath = Join-Path $tempRoot 'source.zip'
$extractPath = Join-Path $tempRoot 'source'
$backupPath = "$projectFullPath.backup-$timestamp"
$deploymentStarted = $false
$mcpStopped = $false
$tunnelShouldRun = Test-Path -LiteralPath $TunnelClientPath -PathType Leaf
$tunnelRestarted = $false

$nodePath = Get-RequiredExecutable -DisplayName 'node.exe' -Candidates @(
  'C:\Program Files\nodejs\node.exe',
  'node.exe'
)
$npmPath = Get-RequiredExecutable -DisplayName 'npm.cmd' -Candidates @(
  'C:\Program Files\nodejs\npm.cmd',
  'npm.cmd'
)
$nodeDirectory = Split-Path -Parent $nodePath
if (($env:Path -split ';') -notcontains $nodeDirectory) {
  $env:Path = "$nodeDirectory;$env:Path"
}

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
  # Keep the existing NetEase tunnel client running. It automatically reconnects
  # when the local MCP server is restarted, and this avoids touching other profiles.
  Stop-McpServer -ListenPort $Port
  $mcpStopped = $true

  New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
  & robocopy.exe $projectFullPath $backupPath /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw "Backup failed with robocopy exit code $LASTEXITCODE." }

  $deploymentStarted = $true
  & robocopy.exe $releasePath $projectFullPath /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw "Deployment failed with robocopy exit code $LASTEXITCODE." }

  Write-Host '5/5 Starting the MCP server and checking health...'
  $health = Start-McpServer -NodePath $nodePath -WorkingDirectory $projectFullPath -ListenPort $Port
  if ($tunnelShouldRun) {
    Start-TunnelClient -ExecutablePath $TunnelClientPath -ProfileName $TunnelProfile -LogDirectory (Split-Path -Parent $TunnelClientPath)
    $tunnelRestarted = $true
  }
  Write-Host ''
  Write-Host "Update successful. MCP status: $($health.status); version: $($health.version)" -ForegroundColor Green
  Write-Host "Rollback copy kept at: $backupPath"
  Write-Host 'If tools were added or renamed, refresh wyy in ChatGPT plugin settings.'
} catch {
  $originalError = $_
  if ($deploymentStarted -and (Test-Path -LiteralPath $backupPath)) {
    Write-Warning 'The new release failed. Restoring the previous working version...'
    Stop-McpServer -ListenPort $Port
    & robocopy.exe $backupPath $projectFullPath /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) {
      Write-Warning "Rollback copy failed with robocopy exit code $LASTEXITCODE. Backup remains at $backupPath"
    } else {
      Write-Host 'Previous files restored.' -ForegroundColor Yellow
    }
  }
  if ($mcpStopped -and (Test-Path -LiteralPath (Join-Path $projectFullPath 'src\server.js'))) {
    try {
      Start-McpServer -NodePath $nodePath -WorkingDirectory $projectFullPath -ListenPort $Port | Out-Null
      Write-Host 'MCP server restarted.' -ForegroundColor Yellow
    } catch {
      Write-Warning "MCP restart failed: $($_.Exception.Message)"
    }
  }
  if ($tunnelShouldRun -and -not $tunnelRestarted) {
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
