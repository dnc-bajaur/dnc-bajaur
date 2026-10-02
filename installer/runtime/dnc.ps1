<#
    District Nerve Center — the one script that starts, stops and opens it.

    Everything the installed system does at runtime goes through here: the scheduled task
    that brings it up at boot, the desktop icon somebody clicks in the morning, the Start
    Menu entries, and the uninstaller. One script rather than five, for the reason ADR-0007
    gives for one process: at 02:00 there must be one thing to look at.

        dnc.ps1 start     start the database and the server, wait until it answers
        dnc.ps1 stop      stop both, in the right order
        dnc.ps1 status    what is running, and what the district can reach it on
        dnc.ps1 open      make sure it is up, then open it in the browser  ← the desktop icon

    `open` is the important one. It is what the district clicks every morning, and it must
    work whether or not anything is already running — so it starts what is missing rather
    than reporting that something is missing. A person opening an emergency system at the
    start of a shift should not have to know what a service is.
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'open')]
    [string]$Command = 'status',

    # Where the district's record lives. The default is where the installer puts it; the
    # parameter exists so a release can be exercised end to end against a throwaway folder
    # without touching the real one, and so a district that wants the record on a different
    # drive has somewhere to say so.
    [string]$DataDir = (Join-Path $env:ProgramData 'District Nerve Center Bajaur')
)

$ErrorActionPreference = 'Stop'

$InstallDir = Split-Path -Parent $PSScriptRoot
$PgBin      = Join-Path $InstallDir 'pgsql\bin'
$PgData     = Join-Path $DataDir 'pgdata'
$LogDir     = Join-Path $DataDir 'logs'
$StateFile  = Join-Path $DataDir 'install.json'
$NodeExe    = Join-Path $InstallDir 'node\node.exe'
$ServerJs   = Join-Path $InstallDir 'app\dist\main.js'

if (-not (Test-Path $StateFile)) {
    Write-Host "This installation has not finished setting up." -ForegroundColor Red
    Write-Host "Run Setup again to complete it."
    exit 1
}

$State   = Get-Content $StateFile -Raw | ConvertFrom-Json
$PgPort  = [int]$State.port
$AppPort = [int]$State.appPort
$Origin  = "http://localhost:$AppPort"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

#---------------------------------------------------------------------------------------------
# Is it up?
#---------------------------------------------------------------------------------------------

function Test-Database {
    & "$PgBin\pg_isready.exe" -h 127.0.0.1 -p $PgPort -q
    return $LASTEXITCODE -eq 0
}

<#
    Ask the server, rather than looking for a process called node.

    A node process that is running and not answering is the failure this has to catch — the
    same argument the client makes about `navigator.onLine`, which reports that the machine
    has a network interface rather than that anything gets through. `/health` is the only
    answer that means the district can actually file a report.
#>
function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri "$Origin/health" -TimeoutSec 3 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

#---------------------------------------------------------------------------------------------
# Start
#---------------------------------------------------------------------------------------------

function Start-Database {
    if (Test-Database) { return }

    <#
        Detached, with the log redirected.

        Calling pg_ctl in the foreground leaves postgres holding this console's stdout handle,
        so the shell never returns even though the database is up — which looks exactly like a
        hang, and is why `scripts/dev-db.ps1` carries the same note. We poll for readiness
        ourselves instead.
    #>
    Start-Process -FilePath "$PgBin\pg_ctl.exe" `
        -ArgumentList @('-D', "`"$PgData`"", '-l', "`"$LogDir\postgres.log`"", '-o', "`"-p $PgPort`"", 'start') `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$LogDir\pg_ctl.out" `
        -RedirectStandardError  "$LogDir\pg_ctl.err"

    for ($i = 0; $i -lt 75; $i++) {
        if (Test-Database) { return }
        Start-Sleep -Milliseconds 400
    }

    throw "The database did not start within 30 seconds. See $LogDir\postgres.log"
}

function Start-Server {
    if (Test-Server) { return }

    Start-Process -FilePath $NodeExe `
        -ArgumentList @("`"$ServerJs`"") `
        -WorkingDirectory (Join-Path $InstallDir 'app') `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$LogDir\server.log" `
        -RedirectStandardError  "$LogDir\server.err"

    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Server) { return }
        Start-Sleep -Milliseconds 400
    }

    throw "The District Nerve Center did not start within 36 seconds. See $LogDir\server.err"
}

#---------------------------------------------------------------------------------------------
# Stop
#---------------------------------------------------------------------------------------------

function Stop-Server {
    <#
        The server first, then the database — the same order `main.ts` uses internally, and for
        the same reason. Taking the database out from under a running escalation pass leaves it
        writing to a closed pool mid-escalation.

        Matched on the path it was started from rather than on the name `node`, so this cannot
        stop somebody else's Node process on a machine that runs one.
    #>
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ServerJs) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Stop-Database {
    if (-not (Test-Database)) { return }
    & "$PgBin\pg_ctl.exe" -D $PgData -m fast -w stop 2>&1 | Out-Null
}

#---------------------------------------------------------------------------------------------

switch ($Command) {
    'start' {
        Start-Database
        Start-Server
        Write-Host "District Nerve Center is running at $Origin"
    }

    'stop' {
        Stop-Server
        Stop-Database
        Write-Host "District Nerve Center is stopped."
    }

    'status' {
        $db  = if (Test-Database) { 'running' } else { 'stopped' }
        $srv = if (Test-Server)   { 'running' } else { 'stopped' }

        Write-Host "Database   $db  (127.0.0.1:$PgPort)"
        Write-Host "Server     $srv  ($Origin)"

        <#
            The address other people use.

            `localhost` is the machine talking to itself and is no use to the duty officer
            holding a phone — which is the case this whole product is built around (ADR-0013).
            The link handed out here is the one that works from the district's own network.
        #>
        $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
               Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }

        foreach ($ip in $ips) {
            Write-Host "On the network at  http://$($ip.IPAddress):$AppPort"
        }
    }

    'open' {
        <#
            What the desktop icon runs.

            It starts whatever is not already running instead of complaining that something is
            not running. If the machine was rebooted and the scheduled task has not caught up,
            or somebody stopped it yesterday, clicking the icon still has to open a working
            system — that is the entire promise of the icon.
        #>
        try {
            Start-Database
            Start-Server
        } catch {
            $message = "The District Nerve Center could not be started.`n`n$($_.Exception.Message)"
            [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
            [System.Windows.Forms.MessageBox]::Show($message, 'District Nerve Center', 'OK', 'Error') | Out-Null
            exit 1
        }

        Start-Process $Origin
    }
}
