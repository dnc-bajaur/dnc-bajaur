# Local development database.
#
# A portable PostgreSQL 17 under %LOCALAPPDATA%\dnc-postgres — not a Windows service, not
# installed system-wide, no elevation required. Nothing runs until you start it, and
# deleting that folder removes it completely.
#
#   .\scripts\dev-db.ps1 start
#   .\scripts\dev-db.ps1 stop
#   .\scripts\dev-db.ps1 status
#   .\scripts\dev-db.ps1 psql
#
# Connection strings live in app/.env, which is gitignored. The password here is a
# local-development value with no production equivalent.

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'psql', 'logs')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:LOCALAPPDATA 'dnc-postgres'
$Bin = Join-Path $Root 'pgsql\bin'
# The data directory lives on D: when it is there, and beside the binaries otherwise.
#
# Moved on 2026-08-13, and the reason is worth keeping: C: is 96 GB, it is chronically full,
# and it reached ZERO free during a test run. PostgreSQL was mid-recovery at the time and died
# with `could not create file ... No space left on device` — a crashed cluster caused by a disk
# that has nothing to do with this project.
#
# Auto-detected rather than set by an environment variable, so it needs no shell setup and says
# where it is by existing. Move the folder back and this script follows it.
$MovedData = 'D:\dnc-postgres-data'
$Data = if (Test-Path (Join-Path $MovedData 'PG_VERSION')) { $MovedData } else { Join-Path $Root 'data' }
$Log = Join-Path $Root 'pg.log'
$Port = 5433

if (-not (Test-Path $Bin)) {
    Write-Host "PostgreSQL not found at $Root." -ForegroundColor Red
    Write-Host "See docs/05-stack.md for how the local cluster is provisioned."
    exit 1
}

switch ($Command) {
    'start' {
        # Launched detached on purpose.
        #
        # Calling pg_ctl directly leaves postgres holding the console's stdout handle, so
        # the calling shell never returns even though the server is up — which looks
        # exactly like a hang. Start-Process with redirected output breaks that
        # inheritance, and we then poll for readiness ourselves.
        Start-Process -FilePath "$Bin\pg_ctl.exe" `
            -ArgumentList @('-D', "`"$Data`"", '-l', "`"$Log`"", '-o', "`"-p $Port`"", 'start') `
            -WindowStyle Hidden `
            -RedirectStandardOutput "$Root\pg_ctl.out" `
            -RedirectStandardError "$Root\pg_ctl.err"

        # Twelve seconds was enough for a clean start and nowhere near enough for a dirty one.
        #
        # On 2026-08-14 C: filled to zero during a test run and killed the cluster again. The
        # restart was fine — PostgreSQL was replaying WAL and fsyncing the data directory, which
        # is exactly what it is supposed to do — but this loop gave up at 12s and printed
        # "did not become ready" over a log whose own last line said
        # `syncing data directory (fsync), elapsed time: 10.00 s`. It read as a broken database.
        # It was a recovering one, and it came up perfectly ~40s later.
        #
        # So: wait five minutes, and while waiting **say which of the two is happening**. A
        # recovery that is progressing and a server that is truly stuck look identical from
        # outside, and the difference is the whole question at 02:00.
        $timeout = [TimeSpan]::FromMinutes(5)
        $started = Get-Date
        $said = $false

        while (((Get-Date) - $started) -lt $timeout) {
            & "$Bin\pg_isready.exe" -h 127.0.0.1 -p $Port -q
            if ($LASTEXITCODE -eq 0) {
                $secs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
                Write-Host "postgres ready on port $Port (${secs}s)"
                exit 0
            }

            # `starting up` is PostgreSQL telling us it is busy, not failing. Say so once, so
            # nobody kills a recovery half way through and makes a real problem out of a wait.
            if (-not $said -and (Test-Path $Log)) {
                $tail = Get-Content $Log -Tail 5 -ErrorAction SilentlyContinue
                if ($tail -match 'starting up|recovering|redo|syncing data directory') {
                    Write-Host 'postgres is recovering after an unclean shutdown - waiting.' -ForegroundColor Yellow
                    $said = $true
                }
            }

            Start-Sleep -Milliseconds 400
        }

        Write-Host "postgres did not become ready in $($timeout.TotalMinutes) minutes. Last log lines:" -ForegroundColor Red
        if (Test-Path $Log) { Get-Content $Log -Tail 20 }
        exit 1
    }
    'stop' {
        & "$Bin\pg_ctl.exe" -D $Data -m fast -w stop
    }
    'status' {
        & "$Bin\pg_isready.exe" -h 127.0.0.1 -p $Port
    }
    'psql' {
        $env:PGPASSWORD = 'devonly_localpg'
        & "$Bin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -d dnc_dev
    }
    'logs' {
        if (Test-Path $Log) { Get-Content $Log -Tail 40 } else { Write-Host 'No log yet.' }
    }
}
