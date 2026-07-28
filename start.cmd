@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":3000 " ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>&1
npm start
