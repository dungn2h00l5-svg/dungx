# Chief of Staff Agent (Claude Agent SDK)

A local copy of Anthropic's cookbook notebook
[`01_The_chief_of_staff_agent.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/claude_agent_sdk/01_The_chief_of_staff_agent.ipynb),
with every supporting file it needs (`chief_of_staff_agent/` and `utils/`), plus setup scripts.

## What you need
1. **Python 3.11 or 3.12**: https://www.python.org/downloads/ (on Windows, tick **"Add python.exe to PATH"** during install).
2. **An Anthropic API key**: https://console.anthropic.com/settings/keys. API usage is billed separately from a Claude.ai subscription, so add a little credit first.

## Install (once)
1. Download this repo: on GitHub click **Code → Download ZIP**, then unzip it. Or run
   `git clone -b claude/focused-sagan-ql5tve https://github.com/dungn2h00l5-svg/dungx.git`
2. Open the `chief_of_staff` folder.
3. Run the setup:
   - **Windows:** double-click `setup_windows.bat`
   - **macOS / Linux:** `bash setup_mac_linux.sh`
4. Open the new `.env` file in Notepad or another text editor and replace the placeholder:
   `ANTHROPIC_API_KEY="sk-ant-..."` (you only need this key; the GitHub and OpenAI keys aren't used here).

## Run
- **Windows:** double-click `start_windows.bat`
- **macOS / Linux:** `bash start_mac_linux.sh`

Jupyter opens in your browser. Run the cells top to bottom with **Shift + Enter**.
If Jupyter asks which kernel to use, pick **"Chief of Staff (Python)"**.

You can also open the folder in VS Code (with the Python and Jupyter extensions) and choose the `.venv` interpreter.

## What's inside
| Path | Purpose |
|---|---|
| `01_The_chief_of_staff_agent.ipynb` | The tutorial notebook |
| `chief_of_staff_agent/agent.py` | The agent used in the last part of the notebook |
| `chief_of_staff_agent/CLAUDE.md` | Company context ("TechStart Inc.") the agent reads |
| `chief_of_staff_agent/financial_data/` | Sample burn-rate, hiring-cost and revenue data |
| `chief_of_staff_agent/scripts/` | Python tools the agent can run (forecasts, hiring impact, decision matrix) |
| `chief_of_staff_agent/.claude/` | Subagents, slash commands, output styles and hooks |
| `utils/` | Helpers that print the agent's activity nicely |

## Troubleshooting
- `python` is not recognized: reinstall Python and tick "Add to PATH", or use the `py` launcher (`py -3.12 -m venv .venv`).
- Authentication error: check that `.env` has your real `ANTHROPIC_API_KEY`, then restart the kernel.
- `ModuleNotFoundError`: the notebook is running on the wrong kernel. Pick "Chief of Staff (Python)".
