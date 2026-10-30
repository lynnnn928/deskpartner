# DeskPartner

**Let your AI agents pick up right where the last one left off—a local-first shared project memory and handoff workspace for multi-AI collaboration.**

[中文文档](README.md) · [Website](https://lynnnn928.github.io/deskpartner/) · [User Manual](https://lynnnn928.github.io/deskpartner/#manual) · [llms.txt](https://lynnnn928.github.io/deskpartner/llms.txt) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Releases](https://github.com/lynnnn928/deskpartner/releases)

> **What DeskPartner Is (and Isn't) in 3 Seconds**
>
> - ❌ **Not an AI orchestration platform**: It does not bundle LLMs, hold API keys, or run inference on its own.
> - ✅ **A standard MCP server & shared local project memory**: It connects to the AI clients you already use (**Claude Desktop, Cursor, Codex**, etc.) and gives them a unified local project handoff note, decision history, 7-state workflow, and human approval gates.
>
> 🤖 **[For AI Assistants]**: If you are an AI agent, call the `get_guide` MCP tool or run `node "$DESKPARTNER_CLI" skill` first to read the onboarding guide and register your identity (`agent register` + `agent credential`) before writing. If DeskPartner is not yet installed locally, read https://lynnnn928.github.io/deskpartner/llms.txt .

---

## Why DeskPartner?

When you work with multiple AI assistants (Claude Desktop, Cursor, Codex, etc.) on a long-running project, three problems quickly surface:

1. **Context silos across chat windows**: Project background and past decisions stay trapped inside separate chat logs—switching tools means repeating everything from scratch.
2. **No single source of truth for progress or verification**: You can't tell at a glance what is truly verified versus what an agent merely claims is "done".
3. **Unbounded write access**: Giving AI agents raw database or file tools means they can overwrite project state or mark their own tasks complete without human review.

### Three Roles, Clear Boundaries

- **AI Assistants (Executors)**: Understand your intent, read project context on demand, execute tasks, and submit verification evidence or proposals.
- **DeskPartner (Shared Local Memory & MCP Server)**: Stores project handoffs, decision history, task transitions, and audit logs locally in SQLite so every agent reads the same truth.
- **You (Decision-Maker & Verifier)**: Control the entry gate (`proposed` → `todo`) and delivery gate (`awaiting_review` → `done`), and approve sensitive changes with one click.

---

## Key Capabilities

- **Cross-Agent Project Handoff Memory**: Every project includes a versioned **Handoff** note (up to 50 revisions) with live `#8-char-id` task badges. When you switch agents, the next session reads the current handoff and continues immediately.
- **7-State Workflow & No Self-Approval**: AI ideas enter `proposed` first; completed work goes to `awaiting_review` with structured verification evidence. Executors cannot mark their own work `done`.
- **4-Tier Permission Model**:
  1. **Read-only queries**: Open access without prompts.
  2. **Daily collaboration writes**: Enabled after a one-time identity approval in the desktop app (revocable anytime).
  3. **UI preference changes**: Per-request or session-scoped approval.
  4. **Destructive actions & protocol/handoff edits**: Bound to a specific target and diff preview—executed by the system only after you click **Approve**.
- **100% Local SQLite Storage**: All data lives in `%APPDATA%\desk-partner\user.db` with automatic pre-migration snapshots. Zero cloud accounts, zero telemetry uploads.

![DeskPartner Project Handoff](docs/assets/project-handoff.png)

---

## Installation (Windows 10 / 11 x64)

1. Download the latest **`DeskPartner.Setup.x.y.z.exe`** from [GitHub Releases](https://github.com/lynnnn928/deskpartner/releases).
2. Run the installer.
   - *Note on Windows SmartScreen*: Because this is an independent open-source project without a commercial code-signing certificate, Windows may show a blue SmartScreen prompt on first launch. Click **"More info"** → **"Run anyway"** to proceed.

---

## Connect Your AI in 3 Steps

You can copy a pre-configured onboarding prompt with your exact local paths from the **`?` (Quick Start)** menu at the bottom-left of the DeskPartner window, or use the blocks below:

### Copy-Paste Onboarding Prompt for Your AI

```text
Call DeskPartner's get_guide tool (or run node "$DESKPARTNER_CLI" skill), register your agent identity (agent register + agent credential), and check my current project handoff notes and open tasks.
```

### Step 1: Add DeskPartner to your MCP Client

Add the following entry to your MCP client configuration (replace the path with your actual installation directory, available in **Quick Start** or **Settings → System**):

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

> **CLI Alternative**: DeskPartner automatically sets the `DESKPARTNER_CLI` user environment variable on launch. Agents with shell access can run `node "$DESKPARTNER_CLI" skill` directly. (Upgrading in the same folder requires no reconfiguration; if you reinstall to a different folder, restart open terminals or update the MCP `command` path and reconnect.)

### Step 2: Let the AI Register Its Identity

Send the onboarding prompt above to your AI agent. It will register its identity and claim a local credential (`~/.deskpartner/credentials.json`), waiting in pending state until you approve it.

### Step 3: Click "Approve" in the Desktop App

A banner will appear in DeskPartner when the new agent registers. Click **Approve** in the **Approval** tab—your AI can now collaborate with you on the workspace.

---

## Data & Privacy

- **100% Local Storage**: All tasks, projects, handoff notes, and local telemetry are stored in `%APPDATA%\desk-partner\user.db` (configurable in Settings).
- **Network Boundary**: DeskPartner **only connects to GitHub Releases when checking for updates** (which can be turned off in *Settings → System → Auto-check for updates*). No user data or telemetry is ever uploaded.

---

## Support, Security & Links

- **Open Source & Trust**: [GitHub Repository](https://github.com/lynnnn928/deskpartner) · [Issue Tracker](https://github.com/lynnnn928/deskpartner/issues) · [Security Policy (`SECURITY.md`)](SECURITY.md) · [Contributing Guide (`CONTRIBUTING.md`)](CONTRIBUTING.md)
- **Support & Sponsor**: DeskPartner is an independent open-source project built for real-world multi-agent workflows. If you find it useful, consider giving the repo a Star or supporting development via [GitHub Sponsors](https://github.com/sponsors/lynnnn928) or [AfDian](https://afdian.com/a/lynnnn928).

---

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 LiLin (lynnnn928).
