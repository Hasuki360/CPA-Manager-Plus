$ErrorActionPreference = 'Stop'

$AppName = 'cpa-manager-plus'
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$DefaultRunDir = Join-Path $ScriptDir 'run'
$DefaultLogDir = Join-Path $ScriptDir 'logs'
$RunDirIsDefault = -not $env:CPA_MANAGER_PLUS_RUN_DIR
$LogDirIsDefault = -not $env:CPA_MANAGER_PLUS_LOG_DIR
$Binary = if ($env:CPA_MANAGER_PLUS_BIN) { $env:CPA_MANAGER_PLUS_BIN } else { Join-Path $ScriptDir "$AppName.exe" }
$RunDir = if ($env:CPA_MANAGER_PLUS_RUN_DIR) { $env:CPA_MANAGER_PLUS_RUN_DIR } else { $DefaultRunDir }
$LogDir = if ($env:CPA_MANAGER_PLUS_LOG_DIR) { $env:CPA_MANAGER_PLUS_LOG_DIR } else { $DefaultLogDir }
$PidFile = if ($env:CPA_MANAGER_PLUS_PID_FILE) { $env:CPA_MANAGER_PLUS_PID_FILE } else { Join-Path $RunDir "$AppName.pid" }
$LogFile = if ($env:CPA_MANAGER_PLUS_LOG_FILE) { $env:CPA_MANAGER_PLUS_LOG_FILE } else { Join-Path $LogDir "$AppName.log" }
$ErrLogFile = if ($env:CPA_MANAGER_PLUS_ERR_LOG_FILE) { $env:CPA_MANAGER_PLUS_ERR_LOG_FILE } else { Join-Path $LogDir "$AppName.err.log" }
$CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User

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

Note:
  Prefer environment variables for runtime configuration. Windows argument
  forwarding follows Start-Process parsing and may be shell-dependent for
  complex values with spaces or quotes.
"@
}

function Resolve-NormalizedPath {
  param([string]$Path)

  try {
    return [System.IO.Path]::GetFullPath($Path)
  } catch {
    return $Path
  }
}

function Set-PrivateAcl {
  param(
    [string]$Path,
    [switch]$Directory
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $inheritFlags = if ($Directory) {
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }

  $acl = if ($Directory) {
    New-Object System.Security.AccessControl.DirectorySecurity
  } else {
    New-Object System.Security.AccessControl.FileSecurity
  }

  $acl.SetOwner($CurrentUserSid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $CurrentUserSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritFlags,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Ensure-PrivateDirectory {
  param(
    [string]$Path,
    [switch]$ManageExisting
  )

  if (-not $Path) {
    return
  }

  if (Test-Path -LiteralPath $Path) {
    if ($ManageExisting) {
      Set-PrivateAcl -Path $Path -Directory
    }
    return
  }

  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  Set-PrivateAcl -Path $Path -Directory
}

function Should-ManageExistingDirectory {
  param([string]$Path)

  if (-not $Path) {
    return $false
  }

  $normalizedPath = Resolve-NormalizedPath $Path
  if ($RunDirIsDefault -and $normalizedPath -ieq (Resolve-NormalizedPath $RunDir)) {
    return $true
  }
  if ($LogDirIsDefault -and $normalizedPath -ieq (Resolve-NormalizedPath $LogDir)) {
    return $true
  }

  return $false
}

function Prepare-PrivateFile {
  param([string]$Path)

  $parent = Split-Path -Parent $Path
  if ($parent) {
    $manageParent = Should-ManageExistingDirectory -Path $parent
    Ensure-PrivateDirectory -Path $parent -ManageExisting:$manageParent
  }

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType File -Force -Path $Path | Out-Null
  }

  Set-PrivateAcl -Path $Path
}

function Get-ProcessSnapshot {
  param([int]$ProcessId)

  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
  } catch {
    return $null
  }

  $startTimeUtc = $null
  try {
    $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
  } catch {
  }

  $cimProcess = $null
  try {
    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
  }

  $binaryPath = $null
  if ($cimProcess -and $cimProcess.ExecutablePath) {
    $binaryPath = Resolve-NormalizedPath $cimProcess.ExecutablePath
  } else {
    try {
      $binaryPath = Resolve-NormalizedPath $process.MainModule.FileName
    } catch {
    }
  }

  $commandLine = $null
  if ($cimProcess -and $cimProcess.CommandLine) {
    $commandLine = $cimProcess.CommandLine.Trim()
  }

  [pscustomobject]@{
    Pid          = $process.Id
    StartTimeUtc = $startTimeUtc
    BinaryPath   = $binaryPath
    CommandLine  = $commandLine
    Process      = $process
  }
}

function Read-PidRecord {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }

  $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if (-not $raw) {
    return [pscustomobject]@{ Format = 'invalid' }
  }

  if ($raw -match '^\d+$') {
    return [pscustomobject]@{
      Format = 'legacy'
      Pid = [int]$raw
    }
  }

  try {
    $record = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return [pscustomobject]@{ Format = 'invalid' }
  }

  $pidValue = 0
  if (-not [int]::TryParse([string]$record.pid, [ref]$pidValue)) {
    return [pscustomobject]@{ Format = 'invalid' }
  }

  [pscustomobject]@{
    Format       = 'metadata'
    Pid          = $pidValue
    StartTimeUtc = [string]$record.startTimeUtc
    BinaryPath   = [string]$record.binaryPath
    CommandLine  = [string]$record.commandLine
  }
}

function Get-PidRecordState {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return [pscustomobject]@{ State = 'missing' }
  }

  $record = Read-PidRecord
  if (-not $record -or $record.Format -eq 'invalid') {
    return [pscustomobject]@{ State = 'invalid'; Record = $record }
  }

  $snapshot = Get-ProcessSnapshot -ProcessId $record.Pid
  if (-not $snapshot) {
    return [pscustomobject]@{ State = 'stale'; Record = $record }
  }

  if ($record.Format -ne 'metadata' -or -not $record.StartTimeUtc) {
    return [pscustomobject]@{ State = 'conflict'; Record = $record; Snapshot = $snapshot }
  }

  if (-not $snapshot.StartTimeUtc -or $snapshot.StartTimeUtc -ne $record.StartTimeUtc) {
    return [pscustomobject]@{ State = 'conflict'; Record = $record; Snapshot = $snapshot }
  }

  if ($record.BinaryPath -and $snapshot.BinaryPath) {
    if ((Resolve-NormalizedPath $snapshot.BinaryPath) -ieq (Resolve-NormalizedPath $record.BinaryPath)) {
      return [pscustomobject]@{ State = 'active'; Record = $record; Snapshot = $snapshot }
    }

    return [pscustomobject]@{ State = 'conflict'; Record = $record; Snapshot = $snapshot }
  }

  if ($record.CommandLine -and $snapshot.CommandLine -and $record.CommandLine -eq $snapshot.CommandLine) {
    return [pscustomobject]@{ State = 'active'; Record = $record; Snapshot = $snapshot }
  }

  return [pscustomobject]@{ State = 'conflict'; Record = $record; Snapshot = $snapshot }
}

function Write-PidRecord {
  param([int]$ProcessId)

  $snapshot = Get-ProcessSnapshot -ProcessId $ProcessId
  if (-not $snapshot -or -not $snapshot.StartTimeUtc -or (-not $snapshot.BinaryPath -and -not $snapshot.CommandLine)) {
    return $false
  }

  $tmpFile = "${PidFile}.tmp.$PID"
  $record = [pscustomobject]@{
    pid          = $snapshot.Pid
    startTimeUtc = $snapshot.StartTimeUtc
    binaryPath   = $snapshot.BinaryPath
    commandLine  = $snapshot.CommandLine
  }

  Prepare-PrivateFile -Path $tmpFile
  $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $tmpFile
  Set-PrivateAcl -Path $tmpFile
  Move-Item -LiteralPath $tmpFile -Destination $PidFile -Force
  Set-PrivateAcl -Path $PidFile
  return $true
}

function Prepare-RuntimePaths {
  Ensure-PrivateDirectory -Path $RunDir -ManageExisting:(Should-ManageExistingDirectory -Path $RunDir)
  Ensure-PrivateDirectory -Path $LogDir -ManageExisting:(Should-ManageExistingDirectory -Path $LogDir)
  Prepare-PrivateFile -Path $LogFile
  Prepare-PrivateFile -Path $ErrLogFile
}

function Start-App {
  param([string[]]$AppArgs)

  if (-not (Test-Path -LiteralPath $Binary)) {
    throw "Binary does not exist: $Binary"
  }

  $state = Get-PidRecordState
  switch ($state.State) {
    'active' {
      Write-Host "$AppName is already running with PID $($state.Record.Pid)"
      return
    }
    'stale' {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
    'invalid' {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
    'conflict' {
      throw "Refusing to start: $PidFile points to a running process that could not be strongly verified."
    }
  }

  Prepare-RuntimePaths
  Prepare-PrivateFile -Path $PidFile
  Clear-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
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
  Start-Sleep -Seconds 1

  if ((Write-PidRecord -ProcessId $process.Id) -and (Get-PidRecordState).State -eq 'active') {
    Write-Host "$AppName started with PID $($process.Id)"
    Write-Host "Log: $LogFile"
    Write-Host "Error log: $ErrLogFile"
    return
  }

  Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Error "$AppName failed to start. Check logs: $LogFile and $ErrLogFile"
}

function Stop-App {
  $state = Get-PidRecordState
  switch ($state.State) {
    'missing' {
      Write-Host "$AppName is not running"
      return
    }
    'stale' {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      Write-Host "Removed stale PID file for $AppName"
      return
    }
    'invalid' {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      Write-Host "Removed stale PID file for $AppName"
      return
    }
    'conflict' {
      throw "Refusing to stop: $PidFile points to a running process that could not be strongly verified."
    }
  }

  Stop-Process -Id $state.Snapshot.Pid
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    if ((Get-PidRecordState).State -ne 'active') {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      Write-Host "$AppName stopped"
      return
    }
  }

  throw "$AppName did not stop within 10 seconds. PID: $($state.Snapshot.Pid)"
}

function Show-Status {
  $state = Get-PidRecordState
  switch ($state.State) {
    'active' {
      Write-Host "$AppName is running with PID $($state.Record.Pid)"
      Write-Host "PID file: $PidFile"
      Write-Host "Log: $LogFile"
      return
    }
    'missing' {
      Write-Host "$AppName is not running"
      exit 1
    }
    'stale' {
      Write-Host "$AppName is not running; stale PID file: $PidFile"
      exit 1
    }
    'invalid' {
      Write-Host "$AppName is not running; stale PID file: $PidFile"
      exit 1
    }
    'conflict' {
      Write-Host "$AppName status is unknown; $PidFile points to a running process that could not be strongly verified."
      exit 1
    }
  }
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
