# Install Claude Dashboard on Windows (EXPERIMENTAL — testers wanted).
# Registers a logon Scheduled Task that runs the server hidden.
# Run from the repo folder in PowerShell:  .\install.ps1
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = if ($env:CLAUDE_DASH_PORT) { $env:CLAUDE_DASH_PORT } else { '4517' }

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  Write-Error 'node not found on PATH. Install Node.js 18+ first.'
  exit 1
}

# VBScript wrapper so no console window stays open.
$Vbs = Join-Path $AppDir 'run-hidden.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$AppDir"
sh.Run """$Node"" ""$AppDir\server.js""", 0, False
"@ | Set-Content -Path $Vbs -Encoding ASCII

schtasks /End /TN 'ClaudeDashboard' 2>$null | Out-Null
schtasks /Delete /TN 'ClaudeDashboard' /F 2>$null | Out-Null
schtasks /Create /TN 'ClaudeDashboard' /SC ONLOGON /TR "wscript.exe `"$Vbs`"" /F | Out-Null

# Start it now without waiting for next logon.
Start-Process wscript.exe -ArgumentList "`"$Vbs`""

Write-Host 'waiting for server' -NoNewline
for ($i = 0; $i -lt 20; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      Write-Host ''
      Write-Host "OK: claude-dashboard is running at http://127.0.0.1:$Port"
      Write-Host '    It starts automatically at logon (Scheduled Task "ClaudeDashboard").'
      exit 0
    }
  } catch {}
  Write-Host '.' -NoNewline
  Start-Sleep -Milliseconds 500
}
Write-Host ''
Write-Error "server did not respond on port $Port"
exit 1
