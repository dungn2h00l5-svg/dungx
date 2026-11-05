@echo off
REM One-time setup for Windows. Double-click this file, or run it from Command Prompt.
cd /d "%~dp0"
python -m venv .venv || (echo Python not found. Install Python 3.11 or 3.12 from python.org and tick "Add to PATH". & pause & exit /b 1)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m ipykernel install --user --name chief-of-staff --display-name "Chief of Staff (Python)"
if not exist .env copy .env.example .env
echo.
echo Setup done. Open the .env file and paste your ANTHROPIC_API_KEY, then run start_windows.bat
pause
