$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ElectronExe = Join-Path $Root "node_modules\electron\dist\electron.exe"
$ElectronCmd = Join-Path $Root "node_modules\.bin\electron.cmd"

Get-CimInstance Win32_Process -Filter "name = 'electron.exe'" |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*$Root*" -and
    $_.ProcessId -ne $PID
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

if (Test-Path -LiteralPath $ElectronExe) {
  Start-Process -FilePath $ElectronExe -ArgumentList "`"$Root`"" -WorkingDirectory $Root
  exit 0
}

if (Test-Path -LiteralPath $ElectronCmd) {
  Start-Process -FilePath $ElectronCmd -ArgumentList "`"$Root`"" -WorkingDirectory $Root
  exit 0
}

Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run desktop -- `"$Root`"" -WorkingDirectory $Root -WindowStyle Hidden
