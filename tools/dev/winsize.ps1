param([int]$W = 1366, [int]$H = 768)
# Resizes the Worship Studio main window (outer size, like a maximized laptop window).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
$p = Get-Process -Name "Worship Studio" -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
[W32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[W32]::MoveWindow($p.MainWindowHandle, 0, 0, $W, $H, $true) | Out-Null
"resized to $W x $H"
