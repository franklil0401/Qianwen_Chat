$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPath = Join-Path $projectRoot 'server/index.ts'
$recordPath = Join-Path $projectRoot '.local/server.json'
if (-not (Test-Path -LiteralPath $recordPath)) { Write-Output 'No recorded background server.'; exit 0 }
$record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
$service = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid)
if ($service) {
    if ($record.entry -ne $entryPath -or -not $service.CommandLine -or -not $service.CommandLine.Contains($entryPath)) {
        throw 'Process identity does not match this project. No process was stopped.'
    }
    Stop-Process -Id ([int]$record.pid)
    Write-Output ('Stopped local server (PID ' + $record.pid + ').')
}
Remove-Item -LiteralPath $recordPath
