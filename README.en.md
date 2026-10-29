# DeskPartner

**A local control plane for multi-AI workflows: auditable handoffs, enforced review gates, and human-in-the-loop governance.**

[中文文档](README.md) · [Website](https://lynnnn928.github.io/deskpartner/) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Releases](https://github.com/lynnnn928/deskpartner/releases)

---

## Why DeskPartner?

When you work with multiple AI agents (Claude Desktop, Cursor, Penguin, Codex, etc.) across several projects, context gets buried in separate chat windows. Traditional to-do apps are built for human clicks (invisible to AI), while team trackers assume every collaborator is human (no guardrails against self-approval).

**DeskPartner** turns scattered AI sessions into an auditable local workspace backed by a single SQLite source of truth:

1. **Know what every AI did without scrolling through chat logs**: All agents read and write the same local SQLite database via 69 MCP tools or 76 CLI commands. Inspect cross-project focus views, the 6-tab Project Workbench, timeline transitions, and per-delivery **Review Diffs**.
2. **Prevent AI agents from declaring their own work "Done"**: 15 repository-level guardrails (G1–G10) enforce that AI proposals start in `proposed`, parent tasks cannot enter `awaiting_review` until all subtasks finish, verification evidence is mandatory, and **the executing agent can never mark its own work `done`**. Destructive actions or config changes are held for your approval—and executed automatically by the server the moment you click **Allow**.
3. **Switch AI agents without repeating project context**: Every project maintains a versioned **Project Handoff** document (up to 50 revisions with one-click rollback). Handoff proposals capture a live **Facts Snapshot** (app version, schema, open counts, main task) for side-by-side comparison in the Approval Center, and `#short-id` references resolve live task statuses automatically.

### Screenshots

#### 1. Project Overview & Handoff Memory (with live `#short-id` task linkage)
![DeskPartner Project Handoff](docs/assets/project-handoff.png)

#### 2. Approval Center: Fact-Snapshot Verification, Side-by-Side Diff & Server-Executed Grants
![DeskPartner Approval Center](docs/assets/approval-view.png)

#### 3. Multi-Agent 7-State Shared Kanban Board
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
