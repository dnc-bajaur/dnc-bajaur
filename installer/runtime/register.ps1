<#
    Everything the installer has to register with Windows, and the uninstaller has to remove.

        register.ps1 -Install     called at the end of Setup
        register.ps1 -Uninstall   called at the start of removal

    Two things, and both are about the system being available rather than merely installed:

      * **A scheduled task that starts it at boot.** An emergency system that only runs while
        somebody is logged in is not an emergency system. The district's machine reboots after
        a power cut at 03:00 — which in Bajaur is when this matters most — and nothing about
        that reboot involves a person being present to click anything.

      * **A firewall rule.** The application is meant to be reached from the district's own
        network: that is how a duty officer's handset syncs and how an office screen shows the
        board (ADR-0011, ADR-0013). Without the rule, Windows silently drops every one of
        those connections and the system appears to work perfectly on the machine it is
        installed on and nowhere else.

    Failures here are reported and do not stop the installation. Neither of these is required
    for the district to open the application on the machine in front of them, and refusing to
    finish an install over a firewall rule would be this project's own rule about refusals —
    reserved for broken or unsafe — applied backwards.
#>

param(
    [switch]$Install,
    [switch]$Uninstall,
    [string]$InstallDir
)

$ErrorActionPreference = 'Continue'

$TaskName = 'District Nerve Center Bajaur'
$RuleName = 'District Nerve Center Bajaur'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    exit 0
}

if (-not $Install) { exit 0 }

if (-not $InstallDir) { $InstallDir = Split-Path -Parent $PSScriptRoot }

$Script   = Join-Path $InstallDir 'runtime\dnc.ps1'
$DataDir  = Join-Path $env:ProgramData 'District Nerve Center Bajaur'
$State    = Join-Path $DataDir 'install.json'

#---------------------------------------------------------------------------------------------
# Start at boot
#---------------------------------------------------------------------------------------------

try {
    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`" start"

    <#
        Two triggers, deliberately.

        At startup is the one that matters and the one that fails silently: it runs before
        anybody signs in, so nobody sees it not happen. At logon is the belt to that brace —
        if the boot trigger was blocked by policy or the machine came up before the disk was
        ready, the first person to sign in puts it right without knowing they did.

        `AtLogOn` with no user means any user. The task itself still runs as SYSTEM.
    #>
    $triggers = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -AtLogOn)
    )

    # SYSTEM, so it runs with nobody signed in. `Highest` because pg_ctl needs to write into
    # the cluster directory.
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    <#
        `ExecutionTimeLimit 0` is the setting that would otherwise end this quietly: a
        scheduled task is killed after three days by default, and this one is meant to run for
        months. `RestartCount` brings it back if the machine kills it for anything else.

        `DontStopIfGoingOnBatteries` matters here rather than being boilerplate — the district
        machine may well be on a UPS, and a power cut is the moment the system is least
        allowed to stop.
    #>
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

    Register-ScheduledTask -TaskName $TaskName `
        -Description 'Keeps the District Nerve Center running, including after a reboot with nobody signed in.' `
        -Action $action -Trigger $triggers -Principal $principal -Settings $settings | Out-Null

    Write-Host "Registered the startup task."
} catch {
    Write-Host "Could not register the startup task: $($_.Exception.Message)"
    Write-Host "The system will still start from the desktop icon."
}

#---------------------------------------------------------------------------------------------
# Let the district's own network reach it
#---------------------------------------------------------------------------------------------

try {
    if (Test-Path $State) {
        $appPort = [int]((Get-Content $State -Raw | ConvertFrom-Json).appPort)

        Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

        <#
            Inbound, TCP, that one port.

            Scoped to the port the application actually listens on rather than to the program,
            because a program rule would follow `node.exe` to anything else this machine ever
            runs under Node. The database is not opened and must not be: it listens on
            127.0.0.1 only, and everything that reaches the record goes through the server's
            authority checks (INV-05).
        #>
        New-NetFirewallRule -DisplayName $RuleName `
            -Description 'Lets handsets and office screens on the district network reach the District Nerve Center.' `
            -Direction Inbound -Protocol TCP -LocalPort $appPort `
            -Action Allow -Profile Any -Enabled True | Out-Null

        Write-Host "Opened port $appPort for the district network."
    }
} catch {
    Write-Host "Could not add the firewall rule: $($_.Exception.Message)"
    Write-Host "The system will work on this machine. Phones on the district network may not reach it."
}

exit 0
