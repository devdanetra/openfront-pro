@echo off
rem Starts OpenFront (Steam) with OpenFront Pro attached. Needs Node.js 22+.
cd /d "%~dp0.."
node launcher\openfront-pro-launcher.mjs %*
pause
