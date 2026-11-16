$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root "scripts\start-jarvis.ps1"
$ElectronExe = Join-Path $Root "node_modules\electron\dist\electron.exe"
$IconPng = Join-Path $Root "public\jarvis-icon.png"

$Programs = Join-Path ([Environment]::GetFolderPath("Programs")) "Jarvis Dev"
$Desktop = [Environment]::GetFolderPath("Desktop")
$TaskbarPins = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

New-Item -ItemType Directory -Force -Path $Programs | Out-Null
New-Item -ItemType Directory -Force -Path $TaskbarPins | Out-Null

function New-JarvisShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath
  )

  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = "powershell.exe"
  $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`""
  $Shortcut.WorkingDirectory = $Root
  $Shortcut.WindowStyle = 7
  $Shortcut.Description = "Launch Jarvis Dev from source"

  if (Test-Path -LiteralPath $ElectronExe) {
    $Shortcut.IconLocation = "$ElectronExe,0"
  } elseif (Test-Path -LiteralPath $IconPng) {
    $Shortcut.IconLocation = $IconPng
  }

  $Shortcut.Save()
}

$StartShortcut = Join-Path $Programs "Jarvis Dev.lnk"
$DesktopShortcut = Join-Path $Desktop "Jarvis Dev.lnk"
$TaskbarShortcut = Join-Path $TaskbarPins "Jarvis Dev.lnk"

New-JarvisShortcut -ShortcutPath $StartShortcut
New-JarvisShortcut -ShortcutPath $DesktopShortcut
New-JarvisShortcut -ShortcutPath $TaskbarShortcut

Write-Host "Installed Jarvis Dev shortcuts:"
Write-Host "  Start Menu: $StartShortcut"
Write-Host "  Desktop:    $DesktopShortcut"
Write-Host "  Taskbar pin staging: $TaskbarShortcut"
