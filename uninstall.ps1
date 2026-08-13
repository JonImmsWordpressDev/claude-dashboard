# Remove the Claude Dashboard Scheduled Task (Windows).
schtasks /End /TN 'ClaudeDashboard' 2>$null | Out-Null
schtasks /Delete /TN 'ClaudeDashboard' /F 2>$null | Out-Null
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.CommandLine -match 'claude-dashboard' } |
  Stop-Process -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'run-hidden.vbs') -ErrorAction SilentlyContinue
Write-Host 'OK: claude-dashboard scheduled task removed.'
