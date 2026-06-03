import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { loadConfig, saveConfig, getMonthlySummary, deleteManualAllocation, isManualAllocation, backfillManualExternalIds, getConfigDir } from './core/local-config';
import { CREDITS_PER_USD, usdToCredits } from './core/pricing';
import { AnalyticsWebviewProvider } from './ui/AnalyticsWebviewProvider';
import { StatusBarManager } from './ui/StatusBarItem';
import { syncNow, importHistory, hasImportableHistory } from './bootstrap';
import { findChatSessionFiles, getVSCodeUserDir, setVSCodeUserDir } from './ingestion/chat-parser';
import { findCliSessionFiles, getCopilotCliDir } from './ingestion/cli-parser';

let syncInterval: ReturnType<typeof setInterval> | undefined;

// Default window for the enable-tracking auto-offer. The explicit "Import Historical
// Usage" command lets the user pick 30/90 days or all available history.
const IMPORT_WINDOW_DAYS = 30;

/** ISO timestamp `days` ago, or null for "all available" (no lower bound). */
function sinceIso(days: number | null): string | null {
  return days == null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Resolve the running VS Code build's `User` directory from globalStorageUri
  // (`<User>/globalStorage/<ext-id>`), so Copilot sessions are read from the correct
  // build — Stable, Insiders, portable, or OSS. Must run before the session-file
  // watcher and any sync, which both resolve via getVSCodeUserDir().
  setVSCodeUserDir(path.dirname(path.dirname(context.globalStorageUri.fsPath)));

  const analyticsProvider = new AnalyticsWebviewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tokenyst.analytics', analyticsProvider),
  );

  // Status bar
  const statusBar = new StatusBarManager(context);
  await statusBar.refresh();

  function refreshAll(): void {
    analyticsProvider.refresh().catch(() => {});
    statusBar.refresh().catch(() => {});
  }

  // Backfill historical usage within the given window (`since` = null imports all
  // available), then refresh. `label` describes the window for progress/result text.
  async function runImport(since: string | null, label: string): Promise<void> {
    if (findChatSessionFiles().length === 0 && findCliSessionFiles().length === 0) {
      vscode.window.showWarningMessage(
        'No Copilot Chat or CLI session files found. Use Copilot Chat or the Copilot CLI first, then try again.',
      );
      return;
    }
    const count = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Tokenyst: importing ${label}…`, cancellable: false },
      async () => importHistory(since),
    );
    refreshAll();
    vscode.window.showInformationMessage(
      count > 0
        ? `Imported ${count} Copilot session(s) from ${label}.`
        : `No usage found in ${label} to import.`,
    );
  }

  // Commands
  context.subscriptions.push(

    vscode.commands.registerCommand('tokenyst.refresh', async () => {
      const freshCfg = await loadConfig();
      if (freshCfg.copilot?.enabled) {
        await syncNow().catch(() => {});
      }
      refreshAll();
    }),

    vscode.commands.registerCommand('tokenyst.setMonthlyBudget', async () => {
      const { monthlyBudgetUsd, displayUnit } = await getMonthlySummary();
      const inDollars = displayUnit === 'dollars';

      // Tier amounts are the monthly credits included in each plan.
      const TIERS: (vscode.QuickPickItem & { credits?: number })[] = [
        { label: '$(copilot) Free',        description: '200 credits / month',    credits: 200 },
        { label: '$(copilot) Pro',         description: '1,500 credits / month',  credits: 1500 },
        { label: '$(copilot) Pro+',         description: '7,000 credits / month',  credits: 7000 },
        { label: '$(copilot) Max',         description: '20,000 credits / month', credits: 20000 },
        { label: '$(copilot) Business',    description: '1,900 credits / month',  credits: 1900 },
        { label: '$(copilot) Enterprise',  description: '3,900 credits / month',  credits: 3900 },
        { label: '$(edit) Custom amount…', description: '' },
      ];

      // Pass the full items so the selected tier's credits are read directly — robust
      // to the two same-named "Pro" entries (a label-based lookup would be ambiguous).
      const pick = await vscode.window.showQuickPick(TIERS, {
        title: 'Set Monthly Budget', placeHolder: 'Choose a plan or enter a custom amount',
      });
      if (!pick) return;

      let budgetUsd: number;
      if (pick.credits != null) {
        budgetUsd = pick.credits / CREDITS_PER_USD;
      } else if (inDollars) {
        const capStr = await vscode.window.showInputBox({
          prompt: 'Monthly budget (USD)',
          value: monthlyBudgetUsd != null ? monthlyBudgetUsd.toFixed(2) : '',
          validateInput: (v) => {
            const n = Number(v);
            return !Number.isFinite(n) || n <= 0 ? 'Enter a positive dollar amount' : null;
          },
        });
        if (capStr === undefined) return;
        budgetUsd = Number(capStr);
      } else {
        const capStr = await vscode.window.showInputBox({
          prompt: 'Monthly budget (credits)',
          value: monthlyBudgetUsd != null ? String(usdToCredits(monthlyBudgetUsd)) : '',
          validateInput: (v) => {
            const n = Number(v);
            return !Number.isInteger(n) || n <= 0 ? 'Enter a positive whole number of credits' : null;
          },
        });
        if (capStr === undefined) return;
        budgetUsd = Number(capStr) / CREDITS_PER_USD;
      }

      const current = await loadConfig();
      current.monthlyBudgetUsd = budgetUsd;
      await saveConfig(current);
      refreshAll();
      const summary = inDollars
        ? `$${budgetUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `${usdToCredits(budgetUsd).toLocaleString()} credits`;
      vscode.window.showInformationMessage(`Monthly budget set to ${summary}.`);
    }),

    vscode.commands.registerCommand('tokenyst.toggleUnit', async () => {
      const current = await loadConfig();
      const next = (current.displayUnit ?? 'credits') === 'credits' ? 'dollars' : 'credits';
      current.displayUnit = next;
      await saveConfig(current);
      refreshAll();
      vscode.window.showInformationMessage(
        `Tokenyst: now showing amounts in ${next === 'dollars' ? 'dollars (USD)' : 'credits'}.`,
      );
    }),

    vscode.commands.registerCommand('tokenyst.toggleStatusBarMetric', async () => {
      const current = await loadConfig();
      current.statusBarMetric = (current.statusBarMetric ?? 'period') === 'period' ? 'today' : 'period';
      await saveConfig(current);
      refreshAll();
    }),

    vscode.commands.registerCommand('tokenyst.showMenu', async () => {
      const cfg = await loadConfig();
      const enabled = cfg.copilot?.enabled ?? false;
      const inDollars = (cfg.displayUnit ?? 'credits') === 'dollars';

      const items: (vscode.QuickPickItem & { command: string })[] = [
        enabled
          ? { label: '$(debug-pause) Disable Copilot Tracking', command: 'tokenyst.disableTracking' }
          : { label: '$(play) Enable Copilot Tracking', command: 'tokenyst.enableTracking' },
        { label: '$(add) Add Manual Allocation', command: 'tokenyst.addAllocation' },
        { label: '$(trash) Remove Manual Allocation', command: 'tokenyst.deleteAllocation' },
        {
          label: inDollars ? '$(credit-card) Show amounts in credits' : '$(credit-card) Show amounts in dollars',
          command: 'tokenyst.toggleUnit',
        },
        { label: '$(dashboard) Set Monthly Budget', command: 'tokenyst.setMonthlyBudget' },
        { label: '$(calendar) Set Renewal Date', command: 'tokenyst.setRenewalDate' },
        { label: '$(cloud-download) Import Historical Usage…', command: 'tokenyst.importHistory' },
        { label: '$(refresh) Sync new usage', command: 'tokenyst.refresh' },
        { label: '$(trash) Reset All Data…', command: 'tokenyst.resetData' },
      ];

      const pick = await vscode.window.showQuickPick(items, {
        title: 'Tokenyst Options',
        placeHolder: 'Choose an action',
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),

    vscode.commands.registerCommand('tokenyst.resetData', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset Tokenyst? This deletes all tracked usage, budget, and settings (~/.tokenyst) and disables tracking. This cannot be undone.',
        { modal: true },
        'Yes',
      );
      if (choice !== 'Yes') return;
      try {
        await fs.rm(getConfigDir(), { recursive: true, force: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Tokenyst: failed to reset data — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      refreshAll();
      vscode.window.showInformationMessage('Tokenyst data reset. Tracking disabled.');
    }),

    vscode.commands.registerCommand('tokenyst.setRenewalDate', async () => {
      const current = await loadConfig();
      const dayStr = await vscode.window.showInputBox({
        title: 'Set Renewal Date',
        prompt: 'Day of month your plan renews (1–31). Leave blank to use the 1st.',
        value: current.renewalDay != null ? String(current.renewalDay) : '',
        validateInput: (v) => {
          if (v.trim() === '') return null;
          const n = Number(v);
          return !Number.isInteger(n) || n < 1 || n > 31 ? 'Enter a whole number between 1 and 31' : null;
        },
      });
      if (dayStr === undefined) return;
      current.renewalDay = dayStr.trim() === '' ? null : Number(dayStr);
      await saveConfig(current);
      refreshAll();
      vscode.window.showInformationMessage(
        current.renewalDay != null
          ? `Renewal day set to the ${current.renewalDay}.`
          : 'Renewal date cleared (using the 1st of each month).',
      );
    }),

    vscode.commands.registerCommand('tokenyst.enableTracking', async () => {
      const chatFiles = findChatSessionFiles();
      const cliFiles = findCliSessionFiles();
      if (chatFiles.length === 0 && cliFiles.length === 0) {
        vscode.window.showWarningMessage(
          'No Copilot Chat or CLI session files found. Use Copilot Chat or the Copilot CLI first, then try again.',
        );
        return;
      }
      const current = await loadConfig();
      current.copilot = {
        enabled: true,
        lastSeenEventsAt: new Date().toISOString(),
      };
      await saveConfig(current);
      refreshAll();
      const parts = [
        chatFiles.length > 0 ? `${chatFiles.length} chat` : null,
        cliFiles.length > 0 ? `${cliFiles.length} CLI` : null,
      ].filter(Boolean).join(' + ');
      vscode.window.showInformationMessage(
        `Copilot tracking enabled. Watching ${parts} session(s).`,
      );

      // Offer to backfill usage from the last 30 days that predates the watermark
      // we just set. The watermark is "now", so anything on disk is earlier usage.
      if (hasImportableHistory(sinceIso(IMPORT_WINDOW_DAYS))) {
        const choice = await vscode.window.showInformationMessage(
          'Found Copilot usage from the last 30 days. Import it so your stats reflect this period?',
          'Import', 'Skip',
        );
        if (choice === 'Import') await runImport(sinceIso(IMPORT_WINDOW_DAYS), 'the last 30 days');
      }
    }),

    vscode.commands.registerCommand('tokenyst.importHistory', async () => {
      const choices: (vscode.QuickPickItem & { days: number | null; windowLabel: string })[] = [
        { label: 'Last 30 days', days: 30, windowLabel: 'the last 30 days' },
        { label: 'Last 90 days', days: 90, windowLabel: 'the last 90 days' },
        {
          label: 'All available',
          description: 'every session still on disk',
          detail: 'Older sessions may be missing, undated (counted as today), or lack usage data and be skipped.',
          days: null,
          windowLabel: 'all available history',
        },
      ];
      const pick = await vscode.window.showQuickPick(choices, {
        title: 'Import Historical Usage',
        placeHolder: 'How far back should Tokenyst scan?',
      });
      if (!pick) return;
      await runImport(sinceIso(pick.days), pick.windowLabel);
    }),

    vscode.commands.registerCommand('tokenyst.disableTracking', async () => {
      const current = await loadConfig();
      if (current.copilot) {
        current.copilot.enabled = false;
        await saveConfig(current);
      }
      refreshAll();
      vscode.window.showInformationMessage('Copilot tracking disabled.');
    }),

    vscode.commands.registerCommand('tokenyst.forceSync', async () => {
      const current = await loadConfig();
      if (!current.copilot?.enabled) {
        vscode.window.showWarningMessage(
          'Copilot tracking is not enabled. Run "Tokenyst: Enable Copilot Tracking" first.',
        );
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Tokenyst: syncing…', cancellable: false },
        async () => {
          await syncNow();
        },
      );
      refreshAll();
      vscode.window.showInformationMessage('Tokenyst: sync complete.');
    }),

    vscode.commands.registerCommand('tokenyst.addAllocation', async () => {
      const { displayUnit } = await getMonthlySummary();
      const inDollars = displayUnit === 'dollars';

      // Get the amount in the active display unit
      const amountStr = await vscode.window.showInputBox({
        title: 'Add Allocation',
        prompt: inDollars ? 'Amount used (in USD)' : 'Amount used (in credits)',
        validateInput: (v) => {
          const n = Number(v);
          return !Number.isFinite(n) || n <= 0
            ? `Enter a positive ${inDollars ? 'dollar amount' : 'number of credits'}`
            : null;
        },
      });
      if (amountStr === undefined) return;

      const amount = Number(amountStr);
      const costUsd = inDollars ? amount : amount / CREDITS_PER_USD;

      // Get the model name
      const model = await vscode.window.showInputBox({
        prompt: 'Model name (e.g., gpt-4, claude-3-opus)',
        value: 'copilot-gpt-4',
      });
      if (model === undefined) return;

      // Get optional repo name
      const repo = await vscode.window.showInputBox({
        prompt: 'Repository (optional)',
        value: '',
      });

      const current = await loadConfig();
      const allocation: typeof current.allocations[0] = {
        costUsd,
        model: model || 'unknown',
        inputTokens: null,
        outputTokens: null,
        cacheCreationTokens: null,
        cacheReadTokens: null,
        filesModified: [],
        at: new Date().toISOString(),
        provider: 'copilot',
        repo: repo && repo.length > 0 ? repo : undefined,
        externalId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        manual: true,
      };

      current.allocations.push(allocation);
      await saveConfig(current);
      refreshAll();
      const amountLabel = inDollars
        ? `$${costUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `${(costUsd * CREDITS_PER_USD).toLocaleString(undefined, { maximumFractionDigits: 1 })} credits`;
      vscode.window.showInformationMessage(
        `Added allocation: ${amountLabel} (${model || 'unknown'})`,
      );
    }),

    vscode.commands.registerCommand('tokenyst.deleteAllocation', async (externalId?: string) => {
      if (!externalId) {
        const cfg = await backfillManualExternalIds();
        const manuals = cfg.allocations.filter(isManualAllocation);
        if (manuals.length === 0) {
          vscode.window.showInformationMessage('No manual allocations to delete.');
          return;
        }
        const items = manuals.map(a => ({
          label: `${(a.costUsd * CREDITS_PER_USD).toLocaleString(undefined, { maximumFractionDigits: 1 })} credits`,
          description: `${a.model}${a.repo ? ` · ${a.repo}` : ''} · ${new Date(a.at).toLocaleDateString()}`,
          externalId: a.externalId!,
        }));
        const pick = await vscode.window.showQuickPick(items, { title: 'Delete Manual Allocation', placeHolder: 'Select an allocation to delete' });
        if (!pick) return;
        externalId = pick.externalId;
      }
      const result = await deleteManualAllocation(externalId);
      if (!result.success) {
        vscode.window.showErrorMessage(`Failed to delete allocation: ${result.error}`);
        return;
      }
      refreshAll();
      vscode.window.showInformationMessage('Manual allocation deleted.');
    }),
  );

  // Background sync loop
  const intervalSec = vscode.workspace.getConfiguration('tokenyst')
    .get<number>('syncIntervalSeconds', 300);
  syncInterval = setInterval(async () => {
    const freshCfg = await loadConfig();
    if (!freshCfg.copilot?.enabled) return;
    await syncNow().catch(() => {});
    refreshAll();
  }, intervalSec * 1000);
  context.subscriptions.push({ dispose: () => { if (syncInterval) clearInterval(syncInterval); } });

  // Watch ~/.tokenyst/config.json for external changes (e.g. CLI usage)
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(path.join(os.homedir(), '.tokenyst')),
      'config.json',
    ),
  );
  configWatcher.onDidChange(refreshAll);
  configWatcher.onDidCreate(refreshAll);
  context.subscriptions.push(configWatcher);

  // Watch Copilot Chat session files for new requests — debounced to avoid
  // syncing mid-write. Fires ~1.5s after the last change event.
  let eventsDebounce: ReturnType<typeof setTimeout> | undefined;
  const eventsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(getVSCodeUserDir()),
      'workspaceStorage/*/chatSessions/*.json*',
    ),
  );
  const onEventsChange = () => {
    if (eventsDebounce) clearTimeout(eventsDebounce);
    eventsDebounce = setTimeout(async () => {
      const cfg = await loadConfig();
      if (!cfg.copilot?.enabled) return;
      await syncNow().catch(() => {});
      refreshAll();
    }, 1500);
  };
  eventsWatcher.onDidChange(onEventsChange);
  eventsWatcher.onDidCreate(onEventsChange);

  // Watch Copilot CLI session logs (~/.copilot/session-state/<id>/events.jsonl) with
  // the same debounced handler, so CLI usage syncs live just like Chat.
  const cliEventsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(getCopilotCliDir()),
      'session-state/*/events.jsonl',
    ),
  );
  cliEventsWatcher.onDidChange(onEventsChange);
  cliEventsWatcher.onDidCreate(onEventsChange);

  context.subscriptions.push(eventsWatcher, cliEventsWatcher, {
    dispose: () => { if (eventsDebounce) clearTimeout(eventsDebounce); },
  });

  // Fire initial sync if tracking is already enabled
  const freshCfg = await loadConfig();
  if (freshCfg.copilot?.enabled) {
    syncNow().catch(() => {});
  }
}

export function deactivate(): void {
  if (syncInterval) clearInterval(syncInterval);
}
