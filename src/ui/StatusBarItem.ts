import * as vscode from 'vscode';
import { getMonthlySummary } from '../core/local-config';
import { usdToCredits } from '../core/pricing';

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // Clicking the item toggles between today's and this period's spend.
    this.item.command = 'tokenyst.toggleStatusBarMetric';
    context.subscriptions.push(this.item);
  }

  async refresh(): Promise<void> {
    const showBar = vscode.workspace.getConfiguration('tokenyst').get<boolean>('showStatusBar', true);
    if (!showBar) { this.item.hide(); return; }

    const { monthlySpentUsd, todaySpentUsd, displayUnit, statusBarMetric } = await getMonthlySummary();

    // Nothing tracked this period — hide entirely (also hides "today" since there's
    // no data to toggle to).
    if (monthlySpentUsd === 0) { this.item.hide(); return; }

    const isToday = statusBarMetric === 'today';
    const amountUsd = isToday ? todaySpentUsd : monthlySpentUsd;
    const periodLabel = isToday ? 'today' : 'this period';
    const otherLabel = isToday ? 'this period' : 'today';

    let amountText: string;
    if (displayUnit === 'dollars') {
      amountText = `$${amountUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      amountText = `${usdToCredits(amountUsd).toLocaleString(undefined, { maximumFractionDigits: 1 })} cr`;
    }

    this.item.text = `$(graph) ${amountText}`;
    this.item.tooltip = `Tokenyst: ${amountText} spent ${periodLabel} · click to show ${otherLabel}`;
    this.item.show();
  }
}
