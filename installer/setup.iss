; District Nerve Center — Bajaur
; The Windows installer.
;
; Built by `build-installer.ps1`, never by opening this file in the Inno Setup IDE and pressing
; Compile: the payload it points at is staged by that script, and a hand-compile silently ships
; whatever happens to be in `stage\` from last time.
;
; What this file is responsible for, beyond copying files:
;
;   * asking for the administrator's number and password, because a system nobody can sign
;     into is not installed
;   * running `first-run.mjs`, which does everything that is not copying
;   * a desktop icon, which is what the district was promised and what they will use
;   * removing all of it, including the parts Windows knows about, on uninstall
;
; It deliberately does NOT delete the district's record on uninstall. See the note at the end.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName    "District Nerve Center Bajaur"
#define AppFull    "District Nerve Center — Bajaur"
#define Publisher  "District Administration, Bajaur"

[Setup]
AppId={{7957F1B7-7C08-4A14-AA48-B7AB525C84F4}
AppName={#AppFull}
AppVersion={#AppVersion}
AppVerName={#AppFull} {#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputBaseFilename=DNC-Bajaur-Setup-{#AppVersion}
SetupIconFile=stage\runtime\app.ico
UninstallDisplayIcon={app}\runtime\app.ico
UninstallDisplayName={#AppFull}

; Per-machine. This is a server: it runs as a scheduled task under SYSTEM so that a reboot at
; 03:00 brings it back with nobody signed in, and that is not something a per-user install can
; do. It also means Setup must be run by an administrator, which is stated on the first page.
PrivilegesRequired=admin

; LZMA2/max because the payload is a Node runtime and a PostgreSQL server — around 220 MB
; staged, and this is going to Bajaur over a district line at least once.
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

WizardStyle=modern
DisableWelcomePage=no
DisableProgramGroupPage=yes
ShowLanguageDialog=no
OutputDir=out

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; A desktop icon, and that is the whole list.
;
; There was a taskbar entry here too, and it was wrong: Setup runs as an administrator, so a
; per-user shortcut lands in the administrator's profile rather than in the profile of the
; officer who will use this — Inno warns about exactly that at compile time. The Start Menu
; entry below is per-machine, works for everybody, and can be pinned to the taskbar from its
; right-click menu by whoever wants it there.
Name: "desktopicon"; Description: "Create a shortcut on the desktop"; GroupDescription: "Shortcuts:"

[Files]
Source: "stage\app\*";     DestDir: "{app}\app";     Flags: ignoreversion recursesubdirs createallsubdirs
Source: "stage\node\*";    DestDir: "{app}\node";    Flags: ignoreversion
Source: "stage\pgsql\*";   DestDir: "{app}\pgsql";   Flags: ignoreversion recursesubdirs createallsubdirs
Source: "stage\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Every shortcut runs the same `open` command, which starts whatever is not running and then
; opens the browser. A person clicking this at the start of a shift should not have to know
; whether anything needed starting.
Name: "{group}\{#AppFull}"; Filename: "{app}\runtime\open.vbs"; IconFilename: "{app}\runtime\app.ico"; Comment: "Open the District Nerve Center"
Name: "{group}\Stop the District Nerve Center"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\runtime\dnc.ps1"" stop"; IconFilename: "{app}\runtime\app.ico"
Name: "{group}\Check the District Nerve Center"; Filename: "powershell.exe"; Parameters: "-NoProfile -NoExit -ExecutionPolicy Bypass -File ""{app}\runtime\dnc.ps1"" status"; IconFilename: "{app}\runtime\app.ico"; Comment: "Shows whether it is running, and the address phones on the district network should use"

Name: "{autodesktop}\{#AppFull}"; Filename: "{app}\runtime\open.vbs"; IconFilename: "{app}\runtime\app.ico"; Tasks: desktopicon; Comment: "Open the District Nerve Center"

[Run]
Filename: "{app}\runtime\open.vbs"; Description: "Open the District Nerve Center now"; Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\runtime\dnc.ps1"" stop"; Flags: runhidden; RunOnceId: "StopDnc"
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\runtime\register.ps1"" -Uninstall"; Flags: runhidden; RunOnceId: "UnregisterDnc"

[Code]
{
  The administrator account page.

  This exists because of a gap that is not obvious until you try to use the system: every
  person loaded from the district's contact list has no password, deliberately — being
  reachable and being able to sign in are separate things, and creating logins for eighty
  officials who have not been told the system exists would be eighty credentials nobody is
  watching. Correct, and it leaves a freshly installed system with nobody who can open it.

  So Setup asks. Nothing is defaulted, nothing is generated and printed on a desk, and there
  is no built-in account with a password in a manual — all three are how a system like this
  ends up compromised by somebody who read the same manual.
}

var
  AccountPage: TInputQueryWizardPage;

{
  A silent installation has no page to type into, so it takes the same three values from the
  command line:

    setup.exe /VERYSILENT /NAME="..." /PHONE="03001234567" /PASSWORD="..."

  This is the one place a password is passed on a command line, and it is a deliberate
  exception rather than a second way of doing it. An interactive install never does — the
  values go into a file in a directory only administrators can write, which is read and
  deleted within seconds — because a command line is visible to every process on the machine
  and appears in Task Manager. Whoever chooses to install silently is choosing that trade for
  a reason this installer cannot second-guess: imaging a set of office machines has no person
  standing at any of them.
}
function Param(Name: String): String;
begin
  Result := Trim(ExpandConstant('{param:' + Name + '|}'));
end;

function AccountName: String;
begin
  if WizardSilent then Result := Param('Name') else Result := Trim(AccountPage.Values[0]);
end;

function AccountPhone: String;
begin
  if WizardSilent then Result := Param('Phone') else Result := AccountPage.Values[1];
end;

function AccountPassword: String;
begin
  if WizardSilent then Result := Param('Password') else Result := AccountPage.Values[2];
end;

procedure InitializeWizard;
begin
  AccountPage := CreateInputQueryPage(wpSelectTasks,
    'Administrator account',
    'Who will set this system up for the district?',
    { A line here may not begin with a hash. The preprocessor scans for one as the first
      non-blank character and reads `#13` as an unknown directive, which aborts the compile
      with an error that says nothing about strings. }
    'This is the account that adds departments, sets routing signals and gives other officers' +
    ' their logins. Everyone else gets an account from inside the application afterwards.' +
    ' ' + #13#10 + #13#10 +
    'Use a mobile number the district already knows. It is how the person signs in, and it is' +
    ' how the system reaches them.');

  AccountPage.Add('Full name:', False);
  AccountPage.Add('Mobile number:', False);
  AccountPage.Add('Password (at least 12 characters):', True);
  AccountPage.Add('Confirm password:', True);
end;

{
  Only digits and a leading +.

  Migration 0006 made a phone number the thing that identifies an account, and `login()`
  considers only rows that have a password hash — so a number typed with spaces or dashes here
  becomes an account nobody can sign into, and the failure appears at the sign-in screen days
  later rather than here where it can be fixed.
}
function CleanPhone(Value: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(Value) do
  begin
    C := Value[I];
    if ((C >= '0') and (C <= '9')) or ((C = '+') and (Result = '')) then
      Result := Result + C;
  end;
end;

{
  One set of rules, checked on the page and again before a silent install starts.

  Written once rather than twice on purpose: an unattended install that accepted a six
  character password the wizard would have refused is a hole that only ever appears on the
  machines nobody watched being set up.
}
function AccountProblem: String;
begin
  Result := '';

  if AccountName = '' then
  begin
    Result := 'Please give the name of the person who will administer the system.' + #13#10 +
              'It appears against everything they do in the record.';
    Exit;
  end;

  if Length(CleanPhone(AccountPhone)) < 7 then
  begin
    Result := 'That does not look like a mobile number.' + #13#10 +
              'Enter it in full, for example 03001239000.';
    Exit;
  end;

  { Twelve, not the ten `passwords.ts` enforces. That file sets a deliberately low floor and
    says the real protection is rate limiting and instant revocation — both of which exist. But
    this is the one account that can reach every department in the district, it is chosen once
    by somebody who is not thinking about passwords, and it is the only one nobody else can
    revoke. }
  if Length(AccountPassword) < 12 then
  begin
    Result := 'The password must be at least 12 characters.' + #13#10 +
              'This account can see and change every department in the district.';
    Exit;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID <> AccountPage.ID then Exit;

  Problem := AccountProblem;
  if Problem <> '' then
  begin
    MsgBox(Problem, mbError, MB_OK);
    Result := False;
    Exit;
  end;

  { Only the wizard has a confirmation field. A silent install has one value and nothing to
    compare it against, which is part of what the operator takes on by choosing silent. }
  if AccountPage.Values[2] <> AccountPage.Values[3] then
  begin
    MsgBox('The two passwords do not match.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
end;

{
  Stop a silent install before it copies anything, rather than after.

  Returning a message here is the documented way to fail cleanly: Setup shows it, writes it to
  the log, and leaves the machine untouched. Discovering the problem at the end would leave
  200 MB installed and no account able to sign into it.
}
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not WizardSilent then Exit;

  Result := AccountProblem;
  if Result <> '' then
    Result := Result + #13#10 + #13#10 +
              'A silent installation takes these from the command line:' + #13#10 +
              '  /NAME="..." /PHONE="03001234567" /PASSWORD="..."';
end;

{ JSON, written by hand because Inno has no encoder and this has exactly three strings in it.
  A password may legitimately contain a backslash or a quotation mark, and either one would
  otherwise produce a file `first-run.mjs` cannot parse — after Setup has finished, with no
  account created and no obvious reason why. }
function JsonEscape(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure WriteHandoff;
var
  Path: String;
  Lines: TArrayOfString;
begin
  Path := ExpandConstant('{app}\first-run.json');

  SetArrayLength(Lines, 5);
  Lines[0] := '{';
  Lines[1] := '  "name": "'     + JsonEscape(AccountName)     + '",';
  Lines[2] := '  "phone": "'    + CleanPhone(AccountPhone)    + '",';
  Lines[3] := '  "password": "' + JsonEscape(AccountPassword) + '"';
  Lines[4] := '}';

  SaveStringsToFile(Path, Lines, False);
end;

{
  Run `first-run.mjs`, and show what it said if it fails.

  The whole reason this is run from `CurStepChanged` rather than from `[Run]` is the failure
  path: `[Run]` can show a generic "the program returned an error code", and this script's
  messages are written for the person standing at the machine. Losing them would waste the
  effort of writing them.
}
procedure RunFirstRun;
var
  ResultCode: Integer;
  Command, LogPath, Output: AnsiString;
begin
  LogPath := ExpandConstant('{tmp}\first-run.log');

  Command := '/C ""' + ExpandConstant('{app}\node\node.exe') + '" ' +
             '"' + ExpandConstant('{app}\runtime\first-run.mjs') + '" ' +
             '--install-dir "' + ExpandConstant('{app}') + '" ' +
             '--data-dir "' + ExpandConstant('{commonappdata}\District Nerve Center Bajaur') + '"' +
             ' > "' + LogPath + '" 2>&1"';

  WizardForm.StatusLabel.Caption := 'Setting up the district record. This takes about a minute.';

  { SuppressibleMsgBox throughout, not MsgBox. A silent install has nobody to click OK, and a
    plain MsgBox there leaves Setup waiting for ever on a dialog no one can see — which on a
    machine being imaged unattended looks exactly like a hang. Suppressed, the text still goes
    to the Setup log, which is where an unattended install's failures are read anyway. }
  if not Exec(ExpandConstant('{cmd}'), Command, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    SuppressibleMsgBox('Setup could not start the database.' + #13#10 +
                       SysErrorMessage(DLLGetLastError()), mbCriticalError, MB_OK, IDOK);
    Abort;
  end;

  if ResultCode <> 0 then
  begin
    if not LoadStringFromFile(LogPath, Output) then
      Output := 'No further detail was recorded.';

    SuppressibleMsgBox('The District Nerve Center was copied onto this machine, but setting ' +
           'up its database did not finish.' + #13#10 + #13#10 +
           Output + #13#10 +
           'Nothing has been lost. Running Setup again will continue from where this stopped.',
           mbCriticalError, MB_OK, IDOK);
    Abort;
  end;

  {
    Keep the log, and surface anything it flagged.

    On success this output used to be thrown away, and one of the things in it matters: if the
    number given belongs to somebody whose post is a department rather than one of the two
    offices, the account works but administers **that department only**. Discarding that note
    would leave the district to discover it as "the dashboard looks wrong", weeks later, with
    nothing on any screen explaining why — which is the failure mode this whole project is
    written against.
  }
  { `CopyFile`, not `FileCopy` — the compiler emits a rename hint for the older name, and a
    deprecated alias is a thing that works until the release it does not. }
  CopyFile(LogPath, ExpandConstant('{commonappdata}\District Nerve Center Bajaur\setup.log'), False);

  if LoadStringFromFile(LogPath, Output) then
  begin
    if Pos('NOTE:', Output) > 0 then
      SuppressibleMsgBox(Copy(Output, Pos('NOTE:', Output), Length(Output)), mbInformation,
                         MB_OK, IDOK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then Exit;

  WriteHandoff;
  RunFirstRun;

  { The startup task and the firewall rule. Reported by that script and never fatal: neither is
    needed to open the application on this machine, and refusing to finish an installation over
    a firewall rule would be the wrong trade in a system whose first rule is that an emergency
    is never lost. }
  Exec('powershell.exe',
       '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
         ExpandConstant('{app}\runtime\register.ps1') + '" -Install -InstallDir "' +
         ExpandConstant('{app}') + '"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{
  On removal, the record stays.

  `C:\ProgramData\District Nerve Center Bajaur` holds every emergency the district has ever recorded,
  and the event log is append-only precisely so that nobody can quietly erase it (ADR-0001).
  An uninstaller that deletes it would be the one supported way to destroy the district's own
  history, one wrong click away, with the confirmation dialog reading "Uninstall".

  So it is left, and the person removing the software is told exactly where it is and what
  will happen if they delete it.
}
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;

  DataDir := ExpandConstant('{commonappdata}\District Nerve Center Bajaur');
  if not DirExists(DataDir) then Exit;

  SuppressibleMsgBox('The district''s record has been left in place:' + #13#10 + #13#10 +
         DataDir + #13#10 + #13#10 +
         'It holds every emergency ever recorded on this machine. Installing the District ' +
         'Nerve Center again will pick it up where it left off.' + #13#10 + #13#10 +
         'Deleting that folder destroys the record permanently. Take a backup first.',
         mbInformation, MB_OK, IDOK);
end;
