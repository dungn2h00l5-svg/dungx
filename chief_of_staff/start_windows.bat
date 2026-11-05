@echo off
cd /d "%~dp0"
call .venv\Scripts\activate.bat
jupyter notebook 01_The_chief_of_staff_agent.ipynb
