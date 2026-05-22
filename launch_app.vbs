Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\hbib6\Documents\antigravity\wise-borg"
WshShell.Run "cmd.exe /c npm run app", 0, False
