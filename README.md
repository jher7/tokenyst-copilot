# Tokenyst

Track your **GitHub Copilot Chat** usage, estimate token costs, and watch your spend against a monthly budget — all from a VS Code sidebar and the status bar.

Tokenyst is **strictly local**. It reads Copilot's own session files on your machine, estimates costs from a pricing table baked into the extension, and stores everything in a single JSON file under your home directory. Nothing is sent to any Tokenyst server.


<table>
  <tr>
    <td width="33%">
       <img src="https://raw.githubusercontent.com/jher7/tokenyst-copilot/master/resources/screenshots/screen-1.png" width="100%" alt="Usage Stats">
    </td>
    <td width="33%">
      <img src="https://raw.githubusercontent.com/jher7/tokenyst-copilot/master/resources/screenshots/screen-2.png" width="100%" alt="Breakdown">
    </td>
    <td width="33%">
      <img src="https://raw.githubusercontent.com/jher7/tokenyst-copilot/master/resources/screenshots/screen-3.png" width="100%" alt="Full View">
    </td>
  </tr>
  <tr>
    <td align="center"><strong>Usage Stats</strong></td>
    <td align="center"><strong>Breakdown</strong></td>
    <td align="center"><strong>Full View</strong></td>
  </tr>
</table>

## Features

- **Usage Stats panel** — a dedicated sidebar view with:
  - A monthly budget card showing spend vs. your cap
  - Today / This Week and Avg Daily / Weekly KPIs (with a period filter)
  - A pace projection for the current billing period
  - Bar charts broken down by day of week, model, repo, and task
- **Status bar indicator** — live `$(graph) N cr` of credits spent this period
- **Budget periods** — calendar month by default, or anchored to your plan's renewal day
- **Real token counts** — Tokenyst reads the actual input/output token counts Copilot Chat records for each request (input is context-inclusive), so cost reflects real usage rather than a guess
- **Historical import** — backfill stats from your existing Copilot session history
- **Manual allocations** — add custom allocations directly from the UI with credit amount, model name, and optional repository tracking, and remove them again from a picker list

## How it works

1. The VS Code Copilot Chat extension records each chat session under `<VS Code User>/workspaceStorage/<workspace>/chatSessions/`.
2. Tokenyst watches those files and aggregates usage per session and model, reading the **real** token counts (`promptTokens`/`completionTokens`) that Copilot records on each completed request.
3. The input counts are context-inclusive (system prompt, tool definitions, attached files, and conversation history), so they reflect what Copilot actually sends — not just your typed message.
4. Costs are calculated from a token pricing table baked into the extension (matching GitHub's usage-based billing) and stored as allocations in `~/.tokenyst/config.json`.

## Requirements

- **VS Code** 1.85.0 or newer
- **GitHub Copilot** (the Copilot Chat extension must be installed and in use — that's what produces the session files Tokenyst reads)

## Getting started

1. Install Tokenyst from the VS Code Marketplace.
2. Open the **Tokenyst** view from the activity bar (look for the Tokenyst icon).
3. Run **Tokenyst: Enable Copilot Tracking** from the Command Palette. Tokenyst will check for Copilot session files and offer to import any existing history.
4. Run **Tokenyst: Set Monthly Budget** to pick a Copilot tier preset (Pro, Business, Pro+/Enterprise) or enter a custom amount.
5. *(Optional)* Run **Tokenyst: Set Renewal Date** if your plan renews on a day other than the 1st.

## Commands

All commands are available from the Command Palette under the **Tokenyst** category.

| Command | Description |
|---|---|
| **Set Monthly Budget** | Choose a Copilot tier preset or enter a custom monthly cap |
| **Set Renewal Date** | Day of month (1–31) your plan renews; blank uses the calendar month |
| **Enable Copilot Tracking** | Start watching Copilot session files; offers a historical import |
| **Disable Copilot Tracking** | Stop tracking |
| **Add Manual Allocation** | Add a custom allocation with credit amount, model, and optional repository |
| **Delete Manual Allocation** | Pick from a list of your manually-added allocations and remove one |
| **Import Historical Usage** | Backfill allocations from the last 30 days of sessions |
| **Force Sync** | Re-scan sessions and update usage immediately |
| **Refresh** | Re-scan sessions and refresh the UI |

## Settings

| Setting | Default | Description |
|---|---|---|
| `tokenyst.syncIntervalSeconds` | `300` | How often (in seconds) to scan Copilot session events in the background |
| `tokenyst.showStatusBar` | `true` | Show active budget usage in the status bar |

## Data & privacy

Tokenyst keeps everything on your machine:

- `~/.tokenyst/config.json` — your budget, renewal day, and recorded usage allocations
- `~/.tokenyst/copilot.log` — debug log (only written when debug logging is enabled)
- Reads your VS Code Copilot Chat session files under `workspaceStorage/*/chatSessions/` (written by the Copilot Chat extension)

Tokenyst makes **no network requests** and has **no external dependencies** — it reads only local Copilot Chat session files and writes only to `~/.tokenyst/`. Pricing data is baked into the extension; no pricing or billing service is contacted.

### Editing allocations by hand

Normally you remove a manual allocation with **Tokenyst: Delete Manual Allocation** (a picker lists every manually-added entry). If you'd rather edit the data directly — for example to fix a typo or bulk-remove entries — you can edit `~/.tokenyst/config.json` yourself:

1. **Close VS Code** (or at least the Tokenyst view) so the file isn't rewritten under you.
2. Open `~/.tokenyst/config.json`. On Windows this is `C:\Users\<you>\.tokenyst\config.json`; on macOS/Linux it's `~/.tokenyst/config.json`.
3. Find the `allocations` array. Manually-added entries are the ones with `"manual": true` and/or an `"externalId"` starting with `"manual-"`:

   ```json
   {
     "costUsd": 0.5,
     "model": "copilot-gpt-4",
     "inputTokens": null,
     "outputTokens": null,
     "cacheCreationTokens": null,
     "cacheReadTokens": null,
     "filesModified": [],
     "at": "2026-06-01T12:42:46.000Z",
     "provider": "copilot",
     "externalId": "manual-1717245766000-a1b2c",
     "manual": true
   }
   ```

   > Older manual entries created before tagging existed may have neither marker — they're identifiable as `"provider": "copilot"` entries with all four token fields (`inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`) set to `null`. Tokenyst treats those as manual too.

4. Delete the entire object (including its surrounding `{ }` and the trailing comma) from the array, then save. Make sure the file is still valid JSON.
5. Reopen VS Code; the Usage Stats panel will reflect the change on the next refresh.

Only delete entries you recognize as manual. Synced Copilot allocations always carry numeric token counts and a `copilot-chat-…` `externalId`; removing those just makes them reappear on the next sync.

> **Note:** Spend is shown in **credits** to match Copilot's usage-based billing (100 credits = $1). Where Copilot records a real credit value for a request, Tokenyst uses it directly; otherwise it estimates from token counts and a built-in pricing table (with a cache discount for the repeated system prompt and tool definitions), so those figures are approximate.

## Contact
Please send any questions or comments to **contact@tokenyst.dev**

> **Note:** Are you an engineering manager or team lead? I'm exploring a team dashboard and other QOL features, please contact if interested.

## License

[MIT](LICENSE)
