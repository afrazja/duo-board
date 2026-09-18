On Error Resume Next
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\install.ps1"""
If WScript.Arguments.Named.Exists("repair") Then command = command & " -Repair"
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  MsgBox "Duo Board setup could not start. Windows may have blocked the installer. Download it again from Duo Board Settings. On a work computer, ask your IT team to allow the installer.", 16, "Duo Board Helper"
  WScript.Quit 1
End If
If result <> 0 Then
  MsgBox "Duo Board setup did not finish. Follow the setup error message. Its diagnostic log is at %LOCALAPPDATA%\DuoBoard\Helper\setup.log. If no setup message appeared, Windows may have blocked PowerShell; ask your IT team for help.", 16, "Duo Board Helper"
End If
WScript.Quit result
