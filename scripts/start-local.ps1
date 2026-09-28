$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPath = Join-Path $projectRoot 'server/index.ts'
$stateDir = Join-Path $projectRoot '.local'
$recordPath = Join-Path $stateDir 'server.json'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/index.html'))) { throw 'Run npm run build first.' }
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
if (Test-Path -LiteralPath $recordPath) {
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid)
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($entryPath)) {
        Write-Output ('Already running: http://127.0.0.1:' + $record.port)
        exit 0
    }
}
$localPort = if ($env:PORT) { [int]$env:PORT } else { 3001 }
$nodePath = (Get-Command node).Source
$service = Start-Process -FilePath $nodePath -ArgumentList @('--import', 'tsx', ('"' + $entryPath + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'server.stdout.log') -RedirectStandardError (Join-Path $stateDir 'server.stderr.log') -PassThru
@{ pid=$service.Id; entry=$entryPath; port=$localPort } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    $service.Refresh()
    if ($service.HasExited) { throw 'Server exited. See .local/server.stderr.log; the port may already be in use.' }
    try {
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $localPort + '/api/health') -TimeoutSec 2
        if ($health.model) { Write-Output ('Running: http://127.0.0.1:' + $localPort + ' (PID ' + $service.Id + ')'); exit 0 }
    } catch { }
}
throw 'Server did not become ready. See .local/server.stderr.log.'
