@echo off
setlocal
set ROOT=%~dp0
set TARGET=%ROOT%RadiantOS_Standalone.html

if not exist "%TARGET%" (
  echo [ERROR] RadiantOS_Standalone.html not found.
  echo Run build first or use a package that already contains dist + standalone launcher.
  pause
  exit /b 1
)

start "" "%TARGET%"
exit /b 0
