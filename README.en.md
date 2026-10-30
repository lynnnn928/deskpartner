# DeskPartner

**Let your AI agents log tasks and write handoffs—you just review and approve.**

[中文文档](README.md) · [Website](https://lynnnn928.github.io/deskpartner/) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Releases](https://github.com/lynnnn928/deskpartner/releases)

---

## What is DeskPartner?

When you work with multiple AI agents (Claude, Cursor, Penguin, Codex, etc.), progress gets buried across separate chat windows.

**DeskPartner** is a shared local desktop workspace for your AI agents:

- **Stop scrolling through chat logs**: All your agents update the same local board via MCP or CLI—see what is in progress and what is ready for review at a glance.
- **AI can't mark its own work "Done"**: New ideas from AI land in `proposed` first; finished tasks go to `awaiting_review` and require your click to become `done`.
- **Switch AI agents without repeating context**: Each project keeps a versioned **Handoff** note so the next AI session picks up right where the last one left off.

![DeskPartner Kanban Board](docs/assets/kanban-board.png)

---

## Installation (Windows 10 / 11 x64)

1. Download the latest **`DeskPartner Setup x.y.z.exe`** from [GitHub Releases](https://github.com/lynnnn928/deskpartner/releases).
2. Run the installer.
   - *Note on Windows SmartScreen*: Because this is an independent open-source project without a commercial code-signing certificate, Windows may show a blue SmartScreen prompt on first launch. Click **"More info"** → **"Run anyway"** to proceed.

---

## Connect Your AI in 3 Steps

You can copy a pre-configured onboarding prompt with your exact local paths from the **`?` (Quick Start)** menu at the bottom-left of the DeskPartner window, or set up MCP manually:

### Step 1: Add DeskPartner to your MCP Client

Add the following entry to your MCP client configuration (replace the path with your actual installation directory, available in **Settings → System**):

```json
{
  "mcpServers": {
    "deskpartner": {
      "command": "C:\\Users\\<YourUsername>\\AppData\\Local\\Programs\\desk-partner\\resources\\cli\\mcp.cmd",
      "args": [],
      "env": {
        "DESKPARTNER_AGENT": "agent:claude"
      }
    }
  }
}
```

> **CLI Alternative**: DeskPartner automatically sets the `DESKPARTNER_CLI` user environment variable on launch. Agents with shell access can run `node "$DESKPARTNER_CLI" skill` directly.

### Step 2: Let the AI Register Its Identity

Ask your AI agent:

> "Call DeskPartner's `get_guide` tool (or run `node "$DESKPARTNER_CLI" skill`), register your agent identity, claim your local credential, and check my current projects."

### Step 3: Click "Approve" in the Desktop App

A banner will appear in DeskPartner when the new agent registers. Click **Approve** in the **Approval** tab—your AI can now collaborate with you on the board.

---

## Data & Privacy

- **100% Local Storage**: All tasks, projects, handoff notes, and local telemetry are stored in `%APPDATA%\desk-partner\user.db` (configurable in Settings).
- **Network Boundary**: DeskPartner **only connects to GitHub Releases when checking for updates** (which can be turned off in *Settings → System → Auto-check for updates*). No user data or telemetry is ever uploaded.

---

## Support & Sponsor

DeskPartner is an independent open-source project built for real-world multi-agent workflows. If you find it useful, consider giving the repo a Star or supporting development via [GitHub Sponsors](https://github.com/sponsors/lynnnn928) or [AfDian](https://afdian.com/a/lynnnn928).

---

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 LiLin (lynnnn928).
