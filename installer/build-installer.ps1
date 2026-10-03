<#
    Build the thing the district actually receives: one `setup.exe`, and the ZIP around it.

        .\installer\build-installer.ps1

    This is the only supported way to produce a release. It builds the application from
    source, stages everything the installed system needs — including the Node runtime and a
    PostgreSQL server, because the district must not have to install either — and hands the
    result to Inno Setup.

    **Nothing here is copied from a running installation.** Every file comes from source or
    from a named upstream directory, so a release cannot quietly contain yesterday's build,
    a developer's `.env`, or the local test database's leftovers. The one exception is the
    PostgreSQL binaries, which are copied from a local unpacked distribution and pruned; see
    `Copy-Postgres` for what is dropped and why.
#>

param(
    # Where PostgreSQL 17 is unpacked. The default is the portable cluster `scripts/dev-db.ps1`
    # uses, so a machine set up for development can build a release with no extra arguments.
    [string]$PostgresDir = 'D:\dnc-bajaur-postgres\pgsql',
    [string]$NodeExe     = (Get-Command node -ErrorAction SilentlyContinue).Source,
    [string]$Version     = '1.0.0',
    # ffmpeg, for Activities videos (ADR-0039 §4): any unpacked build under this folder.
    [string]$FfmpegDir   = 'D:\dnc-bajaur-ffmpeg',
    [switch]$NoFfmpeg,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$Here    = $PSScriptRoot
$Root    = Split-Path -Parent $Here
$AppDir  = Join-Path $Root 'app'
$Stage   = Join-Path $Here 'stage'
$Out     = Join-Path $Here 'out'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "   $text" -ForegroundColor DarkGray }

#---------------------------------------------------------------------------------------------
# Prerequisites, checked before anything is deleted
#---------------------------------------------------------------------------------------------

Step 'Checking prerequisites'

$Iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Iscc) {
    throw "Inno Setup 6 was not found. Install it with:  winget install JRSoftware.InnoSetup"
}
Note "Inno Setup   $Iscc"

if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
    throw "node.exe was not found. Pass -NodeExe, or install Node 22 or later."
}
$nodeVersion = (& $NodeExe --version).Trim()
if ([int](($nodeVersion -replace '^v', '') -split '\.')[0] -lt 22) {
    # `package.json` says >=22 and `main.ts` uses `process.loadEnvFile`. Shipping an older
    # runtime would produce an installer that fails on the district's machine and nowhere else.
    throw "The runtime to be bundled is $nodeVersion. This application needs Node 22 or later."
}
Note "Node         $nodeVersion  ($NodeExe)"

if (-not (Test-Path (Join-Path $PostgresDir 'bin\postgres.exe'))) {
    throw "PostgreSQL was not found at $PostgresDir. Pass -PostgresDir with an unpacked PostgreSQL 17."
}
$pgVersion = (& (Join-Path $PostgresDir 'bin\postgres.exe') --version) -replace '.*\s'
if ([int](($pgVersion -split '\.')[0]) -lt 17) {
    # CI runs against 17 and the backup round trip asserts the version rather than printing
    # it, for the reason `.github/workflows/ci.yml` gives. Shipping 16 would mean the district
    # runs the one version nothing was tested on.
    throw "PostgreSQL $pgVersion was found. This application is built and tested against 17."
}
Note "PostgreSQL   $pgVersion  ($PostgresDir)"

#---------------------------------------------------------------------------------------------
# Build from source
#---------------------------------------------------------------------------------------------

if (-not $SkipBuild) {
    Step 'Building the application'

    Push-Location $AppDir
    try {
        # Production, so the client bundle is minified and ships no sourcemaps. `build.mjs`
        # reads NODE_ENV per build rather than at import for exactly this reason.
        $env:NODE_ENV = 'production'
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'The web client failed to build.' }

        & npm run build:server
        if ($LASTEXITCODE -ne 0) { throw 'The server failed to compile.' }
    } finally {
        Remove-Item Env:\NODE_ENV -ErrorAction SilentlyContinue
        Pop-Location
    }
}

#---------------------------------------------------------------------------------------------
# Stage
#---------------------------------------------------------------------------------------------

Step 'Staging the payload'

<#
    Clean, and check that it is clean.

    Silencing the error here and carrying on is what produced a genuinely baffling failure:
    a locked file left `stage\app\dist` behind, `Copy-Item` then copied the source *into* it,
    and the build failed complaining about `stage\app\dist\dist`. Staging on top of a previous
    attempt is the one thing this step must never do — that is how a release ends up carrying
    a file nobody meant to ship.
#>
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $Stage) {
    throw "Could not clear $Stage. Something is holding a file open there — check for a " +
          "running node.exe or postgres.exe from a previous test, then run this again."
}
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

# --- the application -------------------------------------------------------------------------

$stageApp = Join-Path $Stage 'app'
New-Item -ItemType Directory -Force -Path $stageApp | Out-Null

Copy-Item (Join-Path $AppDir 'dist')     (Join-Path $stageApp 'dist')     -Recurse
Copy-Item (Join-Path $AppDir 'web\dist') (Join-Path $stageApp 'web\dist') -Recurse
Copy-Item (Join-Path $AppDir 'db\migrations') (Join-Path $stageApp 'db\migrations') -Recurse
Copy-Item (Join-Path $AppDir 'package.json')  (Join-Path $stageApp 'package.json')

<#
    The district's own contact list.

    It is gitignored — real officers' mobile numbers do not go in a repository — so it is read
    from the working tree here and shipped inside the installer, which is the district's own
    copy of their own data going back to them. If it is absent the release is still valid:
    `first-run.mjs` skips the load and the district builds their roster from the console.
#>
$seed = Join-Path $AppDir 'db\seed\directory.json'
if (Test-Path $seed) {
    New-Item -ItemType Directory -Force -Path (Join-Path $stageApp 'db\seed') | Out-Null
    Copy-Item $seed (Join-Path $stageApp 'db\seed\directory.json')
    $rows = (Get-Content $seed -Raw | ConvertFrom-Json).rows.Count
    Note "directory.json  $rows rows — REAL CONTACT DATA is in this release"
} else {
    Note "directory.json  absent — the district will start with an empty registry"
}

<#
    A sourcemap is the whole of a file's source.

    `build.mjs` already omits them in a production build, so this is the belt to that brace: a
    release built with -SkipBuild after a development build would otherwise ship every line of
    the client, commented, to be served over the district's network.

    `-Filter`, not `-Include`. The first version of this line used `-Include '*.map'` without a
    wildcard in the path, which PowerShell silently treats as matching nothing — so the guard
    ran on every build, reported nothing, and would not have caught the thing it exists for.
    It is checked below rather than trusted, for the same reason.

    **Scoped to the two directories the server serves, not to the whole payload.** `pg` ships
    sourcemaps of its own inside `node_modules`, which are never sent to a browser — sweeping
    them up as well would make this read as a guarantee about the whole tree, and the next
    person to move `npm ci` above this line would break it without any test noticing. The
    concern is what a browser can fetch, so that is what this names.
#>
foreach ($served in 'dist', 'web\dist') {
    $dir = Join-Path $stageApp $served
    Get-ChildItem $dir -Recurse -File -Filter '*.map' | Remove-Item -Force

    $leftover = @(Get-ChildItem $dir -Recurse -File -Filter '*.map')
    if ($leftover.Count -gt 0) {
        throw "Sourcemaps survived staging in $served`: $($leftover.Name -join ', ')"
    }
}

# The same question asked of the client bundle itself. A development build is unminified, and
# `"use strict";(()=>{` is what esbuild emits with minify on — this is cheap and it is the
# difference between shipping the district a production artefact and shipping them a debug one.
$appJs = (Get-Content (Join-Path $stageApp 'web\dist\app.js') -TotalCount 1) -join ''
if ($appJs.Length -lt 200 -or $appJs -notmatch '^"use strict";\(\(\)=>\{') {
    throw 'web/dist/app.js does not look like a production build. Run without -SkipBuild.'
}

# Production dependencies only. `npm ci` against the committed lockfile rather than `npm
# install`, so a release cannot pick up a version nobody tested.
Step 'Installing production dependencies'

Copy-Item (Join-Path $AppDir 'package-lock.json') (Join-Path $stageApp 'package-lock.json')
Push-Location $stageApp
try {
    & npm ci --omit=dev --ignore-scripts --no-audit --fund=false
    if ($LASTEXITCODE -ne 0) { throw 'Installing production dependencies failed.' }
} finally {
    Pop-Location
}
Remove-Item (Join-Path $stageApp 'package-lock.json') -Force

# --- the Node runtime -------------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'node') | Out-Null
Copy-Item $NodeExe (Join-Path $Stage 'node\node.exe')

# --- PostgreSQL ---------------------------------------------------------------------------

Step 'Staging PostgreSQL'

<#
    The server, and nothing else.

    An unpacked PostgreSQL distribution is around 850 MB, and roughly 670 MB of that is
    pgAdmin — a graphical database editor. Shipping it to the district would be a second way
    into the record that goes around every authority check the application makes (INV-05), on
    the same machine, with the password sitting in `.env` beside it. It is dropped because it
    should not exist here, not because of its size.

    The rest is ordinary pruning: `doc` is the manual, `include` is C headers for building
    extensions, `StackBuilder` downloads more software from the internet, and `share/locale`
    is translated server messages the cluster never uses because `first-run.mjs` creates it
    with `--locale=C`.
#>
$stagePg = Join-Path $Stage 'pgsql'
foreach ($dir in 'bin', 'lib', 'share') {
    Copy-Item (Join-Path $PostgresDir $dir) (Join-Path $stagePg $dir) -Recurse
}
Remove-Item (Join-Path $stagePg 'share\locale') -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem $PostgresDir -File -Filter '*license*' | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $stagePg $_.Name)
}

# --- ffmpeg, for Activities videos (ADR-0039 §4) -----------------------------------------------

<#
    Without ffmpeg an officer's video waits for ever: it is kept, never converted, and both the
    DC's Activities screen and `npm run doctor` say so. So the release carries it — the two
    programs the application runs, `ffmpeg.exe` and `ffprobe.exe`, and nothing else from the
    build (no `ffplay`, no docs). They are GPL: shipped unmodified, as separate programs, with
    their licence beside them. `-NoFfmpeg` builds without them, for a district that installs
    ffmpeg itself and sets FFMPEG_PATH; the installed system then says videos are waiting.
#>
if ($NoFfmpeg) {
    Note 'ffmpeg       not bundled (-NoFfmpeg): videos wait until FFMPEG_PATH is set'
} else {
    Step 'Staging ffmpeg'
    $ffmpegExe = Get-ChildItem $FfmpegDir -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $ffmpegExe) {
        throw "ffmpeg was not found under $FfmpegDir. Pass -FfmpegDir with an unpacked ffmpeg build, or -NoFfmpeg to build without it."
    }
    $ffBin   = $ffmpegExe.DirectoryName
    $ffRoot  = Split-Path -Parent $ffBin
    $stageFf = Join-Path $Stage 'ffmpeg'
    New-Item -ItemType Directory -Force -Path $stageFf | Out-Null
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
        $src = Join-Path $ffBin $exe
        if (-not (Test-Path $src)) { throw "$exe was not found beside ffmpeg.exe in $ffBin." }
        Copy-Item $src (Join-Path $stageFf $exe)
    }
    Get-ChildItem $ffRoot -File | Where-Object { $_.Name -match 'LICENSE|README' } | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $stageFf $_.Name)
    }
    Note "ffmpeg       $((& (Join-Path $stageFf 'ffmpeg.exe') -version | Select-Object -First 1))"
}

# --- the runtime scripts and the icon ------------------------------------------------------

Copy-Item (Join-Path $Here 'runtime') (Join-Path $Stage 'runtime') -Recurse
Copy-Item (Join-Path $AppDir 'web\icons\app.ico') (Join-Path $Stage 'runtime\app.ico')

$size = [math]::Round(((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 0)
Note "staged $size MB"

#---------------------------------------------------------------------------------------------
# Compile the installer
#---------------------------------------------------------------------------------------------

Step 'Building setup.exe'

Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Out | Out-Null

& $Iscc "/DAppVersion=$Version" "/O$Out" (Join-Path $Here 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }

$setup = Get-ChildItem $Out -Filter '*.exe' | Select-Object -First 1
$setupMb = [math]::Round($setup.Length / 1MB, 1)

#---------------------------------------------------------------------------------------------
# The ZIP that actually goes to the district
#---------------------------------------------------------------------------------------------

Step 'Packaging for the district'

<#
    A folder, then a ZIP of the folder.

    Zipping the files directly would give the district an archive that unpacks into whatever
    directory they happened to be looking at, scattering four files across a Downloads folder.
    A single named folder inside means it unpacks as one thing, which is also what makes it
    obvious that the guide belongs with the installer.
#>
$release = Join-Path $Out "District Nerve Center Bajaur $Version"
New-Item -ItemType Directory -Force -Path $release | Out-Null

Copy-Item $setup.FullName $release
Get-ChildItem (Join-Path $Here 'guide') -File | ForEach-Object { Copy-Item $_.FullName $release }

$zip = Join-Path $Out "District-Nerve-Center-$Version.zip"
Compress-Archive -Path $release -DestinationPath $zip -CompressionLevel Optimal -Force

$zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)

Write-Host "`nsetup.exe -> $($setup.FullName)  ($setupMb MB)" -ForegroundColor Green
Write-Host "ZIP       -> $zip  ($zipMb MB)" -ForegroundColor Green
Write-Host "`nContents:" -ForegroundColor Green
Get-ChildItem $release | ForEach-Object { Write-Host "   $($_.Name)" }
