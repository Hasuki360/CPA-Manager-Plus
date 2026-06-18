$ErrorActionPreference = 'Stop'

$AppName = 'cpa-manager-plus'
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Binary = if ($env:CPA_MANAGER_PLUS_BIN) { $env:CPA_MANAGER_PLUS_BIN } else { Join-Path $ScriptDir "$AppName.exe" }
$BinaryName = [System.IO.Path]::GetFileName($Binary)
$RunDir = if ($env:CPA_MANAGER_PLUS_RUN_DIR) { $env:CPA_MANAGER_PLUS_RUN_DIR } else { Join-Path $ScriptDir 'run' }
$LogDir = if ($env:CPA_MANAGER_PLUS_LOG_DIR) { $env:CPA_MANAGER_PLUS_LOG_DIR } else { Join-Path $ScriptDir 'logs' }
$PidFile = if ($env:CPA_MANAGER_PLUS_PID_FILE) { $env:CPA_MANAGER_PLUS_PID_FILE } else { Join-Path $RunDir "$AppName.pid" }
$LogFile = if ($env:CPA_MANAGER_PLUS_LOG_FILE) { $env:CPA_MANAGER_PLUS_LOG_FILE } else { Join-Path $LogDir "$AppName.log" }
$ErrLogFile = if ($env:CPA_MANAGER_PLUS_ERR_LOG_FILE) { $env:CPA_MANAGER_PLUS_ERR_LOG_FILE } else { Join-Path $LogDir "$AppName.err.log" }

function Show-Usage {
  Write-Host @"
Usage: .\cpa-manager-plusctl.ps1 <command> [args...]

Commands:
  start [args...]  Start cpa-manager-plus in the background
  stop             Stop the background process
  restart          Restart the background process
  status           Show process status
  logs [lines|-f]  Print recent logs, or follow with -f

Environment overrides:
  CPA_MANAGER_PLUS_BIN          Binary path
  CPA_MANAGER_PLUS_RUN_DIR      Runtime directory, default: .\run
  CPA_MANAGER_PLUS_LOG_DIR      Log directory, default: .\logs
  CPA_MANAGER_PLUS_PID_FILE     PID file path
  CPA_MANAGER_PLUS_LOG_FILE     stdout log file path
  CPA_MANAGER_PLUS_ERR_LOG_FILE stderr log file path
"@
}

function Get-RecordedPid {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }

  $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if (-not $raw) {
    return $null
  }

  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue)) {
    return $pidValue
  }

  return $null
}

function Get-RunningProcess {
  $pidValue = Get-RecordedPid
  if (-not $pidValue) {
    return $null
  }

  try {
    return Get-Process -Id $pidValue -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-ProcessMatchesBinary {
  param([System.Diagnostics.Process]$Process)

  if (-not $Process) {
    return $false
  }

  try {
    $path = $Process.MainModule.FileName
    if ($path) {
      return ([System.IO.Path]::GetFullPath($path) -ieq [System.IO.Path]::GetFullPath($Binary))
    }
  } catch {
  }

  return ($Process.ProcessName -ieq [System.IO.Path]::GetFileNameWithoutExtension($BinaryName))
}

function Get-MatchingProcess {
  $process = Get-RunningProcess
  if ($process -and (Test-ProcessMatchesBinary -Process $process)) {
    return $process
  }

  return $null
}

function Start-App {
  param([string[]]$AppArgs)

  if (-not (Test-Path -LiteralPath $Binary)) {
    throw "Binary does not exist: $Binary"
  }

  $process = Get-MatchingProcess
  if ($process) {
    Write-Host "$AppName is already running with PID $($process.Id)"
    return
  }

  New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

  $startInfo = @{
    FilePath               = $Binary
    WorkingDirectory       = $ScriptDir
    RedirectStandardOutput = $LogFile
    RedirectStandardError  = $ErrLogFile
    WindowStyle            = 'Hidden'
    PassThru               = $true
  }
  if ($AppArgs.Count -gt 0) {
    $startInfo.ArgumentList = $AppArgs
  }

  $process = Start-Process @startInfo
  Set-Content -LiteralPath $PidFile -Value $process.Id
  Start-Sleep -Seconds 1

  if (Get-MatchingProcess) {
    Write-Host "$AppName started with PID $($process.Id)"
    Write-Host "Log: $LogFile"
    Write-Host "Error log: $ErrLogFile"
    return
  }

  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Error "$AppName failed to start. Check logs: $LogFile and $ErrLogFile"
}

function Stop-App {
  $pidValue = Get-RecordedPid
  if (-not $pidValue) {
    Write-Host "$AppName is not running"
    return
  }

  $process = Get-MatchingProcess
  if (-not $process) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Removed stale PID file for $AppName"
    return
  }

  Stop-Process -Id $process.Id
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-MatchingProcess)) {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      Write-Host "$AppName stopped"
      return
    }
  }

  throw "$AppName did not stop within 10 seconds. PID: $($process.Id)"
}

function Show-Status {
  $process = Get-MatchingProcess
  if ($process) {
    Write-Host "$AppName is running with PID $($process.Id)"
    Write-Host "PID file: $PidFile"
    Write-Host "Log: $LogFile"
    return
  }

  if (Test-Path -LiteralPath $PidFile) {
    Write-Host "$AppName is not running; stale PID file: $PidFile"
    exit 1
  }

  Write-Host "$AppName is not running"
  exit 1
}

function Show-Logs {
  param([string]$Option)

  if (-not (Test-Path -LiteralPath $LogFile) -and -not (Test-Path -LiteralPath $ErrLogFile)) {
    throw "Log files do not exist yet: $LogFile and $ErrLogFile"
  }

  if ($Option -eq '-f' -or $Option -eq '--follow') {
    Get-Content -LiteralPath $LogFile, $ErrLogFile -Tail 80 -Wait -ErrorAction SilentlyContinue
    return
  }

  $lineCount = 80
  if ($Option) {
    $lineCount = [int]$Option
  }
  Get-Content -LiteralPath $LogFile, $ErrLogFile -Tail $lineCount -ErrorAction SilentlyContinue
}

$Command = if ($args.Count -gt 0) { $args[0] } else { 'status' }
$AppArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

switch ($Command) {
  'start' { Start-App -AppArgs $AppArgs }
  'stop' { Stop-App }
  'restart' {
    Stop-App
    Start-App -AppArgs $AppArgs
  }
  'status' { Show-Status }
  'logs' { Show-Logs -Option ($AppArgs | Select-Object -First 1) }
  { $_ -in @('help', '-h', '--help') } { Show-Usage }
  default {
    Show-Usage
    exit 1
  }
}
