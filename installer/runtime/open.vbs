' What the desktop icon actually runs.
'
' A shortcut straight to powershell.exe works, but flashes a black console window on the way
' — every morning, on the screen the district starts its day on. This runs the same command
' with the window hidden, so clicking the icon looks like opening an application, because
' that is what the person clicking it is doing.
'
' `0` is the hidden window style and `False` means do not wait: the browser opens and this
' exits, rather than leaving a process sitting behind the tab for the rest of the shift.

Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "dnc.ps1"" open", 0, False
