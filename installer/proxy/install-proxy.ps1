<#
.SYNOPSIS
  Put the district's own domain, over TLS, in front of the district's own machine — M6-36, M6-38.

.DESCRIPTION
  Registers Caddy as a Windows service in front of the application, and moves the application to
  loopback behind it. Run once, on the office machine, after the district has pointed a subdomain
  at this machine (R-21).

  **The three changes ship together or the third one is an outage.** They are done in one script
  for exactly that reason:

    1. Caddy answers on the district's name (443) and on the LAN (3000).
    2. The application moves to 127.0.0.1:3001, bound to loopback so nothing else can reach it.
       Without this, somebody could bypass the proxy — and then `X-Forwarded-For` is a header the
       caller writes, which is a rate limiter an attacker opts out of.
    3. `TRUSTED_PROXIES` pins the proxy's address, so `auth/throttle.ts` believes the header from
       it and from nothing else. **Skip this and every request looks like 127.0.0.1: one officer
       mistyping a password throttles sign-in for the whole district, at 02:00, invisibly.**

  What does not change: the record stays on this machine (ADR-0011). This terminates TLS in
  front of the same process on the same disk.

.PARAMETER Domain
  The subdomain the district pointed at this machine, e.g. dnc.bajaur.gkp.pk.

.PARAMETER Email
  Where Let's Encrypt sends expiry warnings. The last defence when renewal has silently failed.

.PARAMETER CaddyExe
  Path to caddy.exe. Defaults to the copy beside this script.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$CaddyExe = (Join-Path $PSScriptRoot 'caddy.exe')
)

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path ${env:ProgramFiles} 'District Nerve Center Bajaur'
$DataDir    = Join-Path ${env:ProgramData} 'District Nerve Center Bajaur'
$EnvFile    = Join-Path $InstallDir 'app\.env'

function Step($text) { Write-Host "  $text" }
function Fail($text) { Write-Host "  ! $text" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host 'District Nerve Center — putting the district''s domain in front' -ForegroundColor Cyan
Write-Host ''

#-------------------------------------------------------------------------------
# 0. Refuse early, and say what is missing
#-------------------------------------------------------------------------------
#
# Every one of these leaves the district worse off if it half-succeeds: a proxy with no
# certificate, or an application on loopback with nothing in front of it, is a district that
# cannot reach its own system. Refusing before anything changes is the only safe order.

if (-not (Test-Path $CaddyExe)) {
    Fail @"
caddy.exe was not found at $CaddyExe

It is one file with no dependencies. Download the Windows amd64 build from
https://caddyserver.com/download and put caddy.exe beside this script, then run this again.

It is not bundled with the installer because a web server is a thing the district should be
able to update on its own schedule, without waiting for a release of this application.
"@
}

if (-not (Test-Path $EnvFile)) {
    Fail "$EnvFile was not found — install the District Nerve Center first."
}

# DNS, before a certificate is attempted. Let's Encrypt has rate limits, and a name that does
# not resolve burns attempts against them while producing an error nobody reads as "check DNS".
Step "Checking that $Domain points here…"
try {
    $resolved = [System.Net.Dns]::GetHostAddresses($Domain) | ForEach-Object { $_.IPAddressToString }
    Step "  $Domain resolves to $($resolved -join ', ')"
} catch {
    Fail @"
$Domain does not resolve.

The district owns the domain; what is missing is an A record pointing this subdomain at this
machine's public address, plus port 443 forwarded to it (or an outbound tunnel). That is R-21 —
a DNS record and an afternoon. See backlog/how-to-set-these-up.md.
"@
}

#-------------------------------------------------------------------------------
# 1. The application moves to loopback
#-------------------------------------------------------------------------------

Step 'Moving the application behind the proxy…'

$envText = Get-Content $EnvFile -Raw

function Set-EnvValue([string]$text, [string]$key, [string]$value) {
    if ($text -match "(?m)^$key=") {
        return [regex]::Replace($text, "(?m)^$key=.*$", "$key=$value")
    }
    return $text.TrimEnd() + "`n$key=$value`n"
}

# Loopback only. The proxy is the only thing that may reach the application, which is what makes
# trusting its `X-Forwarded-For` safe at all.
$envText = Set-EnvValue $envText 'PORT' '3001'
$envText = Set-EnvValue $envText 'HOST' '127.0.0.1'

# The origin officers' handsets can reach (ADR-0017). Acknowledge links in WhatsApp messages are
# built from this — an office IP here is a link that fails on every real handset in Bajaur.
$envText = Set-EnvValue $envText 'PUBLIC_ORIGIN' "https://$Domain"

# The line ADR-0011 named as "the one to change, deliberately". See the header.
$envText = Set-EnvValue $envText 'TRUSTED_PROXIES' '127.0.0.1'

Set-Content -Path $EnvFile -Value $envText -NoNewline
Step "  PORT=3001, HOST=127.0.0.1, PUBLIC_ORIGIN=https://$Domain, TRUSTED_PROXIES=127.0.0.1"

#-------------------------------------------------------------------------------
# 2. The proxy's configuration
#-------------------------------------------------------------------------------

Step 'Writing the proxy configuration…'

$caddyDir  = Join-Path $DataDir 'proxy'
$caddyFile = Join-Path $caddyDir 'Caddyfile'
New-Item -ItemType Directory -Force -Path $caddyDir | Out-Null

$template = Get-Content (Join-Path $PSScriptRoot 'Caddyfile') -Raw
$template = $template.Replace('dnc.REPLACE_ME.gkp.pk', $Domain)
$template = $template.Replace('REPLACE_ME@example.com', $Email)
Set-Content -Path $caddyFile -Value $template -NoNewline

# Validated before anything is registered. A service that fails to start leaves the application
# on loopback with nothing in front of it — the district unreachable, at the end of a script
# that printed success.
Step 'Checking it…'
& $CaddyExe validate --config $caddyFile --adapter caddyfile 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Fail 'The proxy configuration is not valid. Nothing was registered.' }

#-------------------------------------------------------------------------------
# 3. Register it, and start it
#-------------------------------------------------------------------------------

Step 'Registering the proxy as a service…'

$serviceName = 'DNCBajaurProxy'
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $serviceName | Out-Null
    Start-Sleep -Milliseconds 500
}

$binPath = "`"$CaddyExe`" run --config `"$caddyFile`" --adapter caddyfile"
& sc.exe create $serviceName binPath= $binPath start= auto DisplayName= 'District Nerve Center Bajaur — web address' | Out-Null
# Restart on failure, three times, then keep trying every minute. A proxy that stays down after
# one bad moment takes the district's whole web address with it.
& sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null

Start-Service -Name $serviceName
Step "  $serviceName started"

Step 'Restarting the application on its new port…'
Restart-Service -Name 'DNCBajaur' -ErrorAction SilentlyContinue

#-------------------------------------------------------------------------------
# 4. Prove it, rather than announcing it
#-------------------------------------------------------------------------------
#
# A certificate takes a few seconds to obtain on first run, so this waits rather than checking
# once. What it must never do is print success without having reached the thing it set up: the
# whole class of fault ADR-0017 exists to close was a system that looked installed and did not
# work on the handsets that mattered.

Step 'Waiting for the certificate…'
$ok = $false
foreach ($attempt in 1..20) {
    Start-Sleep -Seconds 3
    try {
        $res = Invoke-WebRequest -Uri "https://$Domain/health" -UseBasicParsing -TimeoutSec 10
        if ($res.StatusCode -eq 200) { $ok = $true; break }
    } catch {
        # Still obtaining, or still starting. Only the last attempt is a failure.
    }
}

Write-Host ''
if ($ok) {
    Write-Host "  Done. The district is at https://$Domain" -ForegroundColor Green
    Write-Host ''
    Write-Host '  Give officers that address, not the IP one. Only the https:// address lets a'
    Write-Host '  phone keep the app working with no signal or use the phone''s location — which'
    Write-Host '  is the whole reason this was set up.'
    Write-Host ''
    Write-Host "  The LAN address still works for the office: http://<this machine>:3000"
} else {
    Write-Host "  The proxy is running but https://$Domain did not answer." -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Almost always one of three things:'
    Write-Host '    - port 443 is not forwarded to this machine from the district''s router'
    Write-Host '    - port 80 is not forwarded either (Let''s Encrypt needs it to issue)'
    Write-Host '    - the DNS record points somewhere else'
    Write-Host ''
    Write-Host "  The application is still reachable in the office at http://<this machine>:3000"
    Write-Host "  Nothing has been lost. Look at $caddyDir\proxy.log"
}
Write-Host ''
