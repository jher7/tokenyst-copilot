import * as vscode from 'vscode';
import { getMonthlySummary } from '../core/local-config';
import { usdToCredits } from '../core/pricing';

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'tokenyst.refresh';
    context.subscriptions.push(this.item);
  }

  async refresh(): Promise<void> {
    const showBar = vscode.workspace.getConfiguration('tokenyst').get<boolean>('showStatusBar', true);
    if (!showBar) { this.item.hide(); return; }

    const { monthlySpentUsd, displayUnit } = await getMonthlySummary();

    if (monthlySpentUsd === 0) { this.item.hide(); return; }

    if (displayUnit === 'dollars') {
      const dollars = monthlySpentUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      this.item.text = `$(graph) $${dollars}`;
      this.item.tooltip = `Tokenyst: $${dollars} spent this period`;
    } else {
      const credits = usdToCredits(monthlySpentUsd).toLocaleString(undefined, { maximumFractionDigits: 1 });
      this.item.text = `$(graph) ${credits} cr`;
      this.item.tooltip = `Tokenyst: ${credits} credits spent this period`;
    }
    this.item.show();
  }
}
