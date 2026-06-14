import * as vscode from 'vscode';
import { loadConfig, getMonthlySummary, getCurrentPeriod } from '../core/local-config';
import { CREDITS_PER_USD } from '../core/pricing';

export class AnalyticsWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this._getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string }) => {
      switch (msg.type) {
        case 'setMonthlyBudget':
          await vscode.commands.executeCommand('tokenyst.setMonthlyBudget'); break;
        case 'enableTracking':
          await vscode.commands.executeCommand('tokenyst.enableTracking'); break;
        case 'disableTracking':
          await vscode.commands.executeCommand('tokenyst.disableTracking'); break;
        case 'forceSync':
          await vscode.commands.executeCommand('tokenyst.forceSync'); break;
        case 'setRenewalDate':
          await vscode.commands.executeCommand('tokenyst.setRenewalDate'); break;
        case 'addAllocation':
          await vscode.commands.executeCommand('tokenyst.addAllocation'); break;
        case 'deleteAllocation':
          await vscode.commands.executeCommand('tokenyst.deleteAllocation'); break;
        case 'toggleUnit':
          await vscode.commands.executeCommand('tokenyst.toggleUnit'); break;
        case 'showMenu':
          await vscode.commands.executeCommand('tokenyst.showMenu'); break;
        case 'refresh':
          await vscode.commands.executeCommand('tokenyst.refresh'); break;
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
    this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this._view) return;
    const cfg = await loadConfig();
    const { monthlyBudgetUsd, monthlySpentUsd, renewalDay, periodStart, periodEnd, displayUnit } = await getMonthlySummary();
    // Previous billing period: the one ending right where the current one starts.
    const lastPeriod = getCurrentPeriod(renewalDay, new Date(Date.parse(periodStart) - 1));
    this._view.webview.postMessage({
      type: 'update',
      allocations: cfg.allocations,
      copilotEnabled: cfg.copilot?.enabled ?? false,
      monthlyBudgetUsd,
      monthlySpentUsd,
      renewalDay,
      periodStart,
      periodEnd,
      lastPeriodStart: lastPeriod.start.toISOString(),
      lastPeriodEnd: lastPeriod.end.toISOString(),
      displayUnit,
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
    }

    /* Monthly section */
    .monthly-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    /* Budget amount on the left, reset label pushed to the right edge. */
    .budget-amount {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
    }
    .monthly-prompt a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .monthly-prompt a:hover { text-decoration: underline; }
    /* Clickable text labels that open an edit prompt (no pencil icon). */
    .edit-label {
      cursor: pointer;
      text-decoration: none;
      color: inherit;
    }
    .edit-label:hover { color: var(--vscode-foreground); text-decoration: underline; }
    /* Highlighted blue to prompt the user when no reset date is set yet. */
    .edit-label.unset { color: var(--vscode-textLink-foreground); }
    .edit-label.unset:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
    .progress-track {
      height: 5px;
      background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.2));
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 3px;
    }
    .progress-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .progress-fill.green  { background: var(--vscode-terminal-ansiGreen,  #4ec94e); }
    .progress-fill.yellow { background: var(--vscode-editorWarning-foreground, #cca700); }
    .progress-fill.red    { background: var(--vscode-errorForeground, #f44747); }

    /* KPI row */
    .kpi-row {
      display: flex;
      gap: 0;
      padding: 6px 12px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
      position: relative;
    }
    .filter-select {
      position: absolute;
      top: 7px;
      right: 12px;
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
      opacity: 0.7;
    }
    .filter-select:hover { opacity: 1; }
    .filter-select option {
      background: var(--vscode-dropdown-background, #1e1e1e);
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    }
    .kpi {
      flex: 1;
    }
    .kpi-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
    }
    .kpi-value {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    /* Chart sections */
    .chart-section {
      padding: 8px 12px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
    }
    .section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }

    /* Insight cards — colour-coded by severity with an icon + title + body. */
    .insights-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .insight {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 8px 10px;
      border-radius: 4px;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
      border-left: 3px solid var(--vscode-descriptionForeground);
    }
    .insight--warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
    .insight--info { border-left-color: var(--vscode-charts-blue, var(--vscode-terminal-ansiBlue, #3794ff)); }
    .insight--good { border-left-color: var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, #89d185)); }
    .insight-icon {
      font-size: 13px;
      line-height: 1.3;
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
    }
    .insight--warn .insight-icon { color: var(--vscode-editorWarning-foreground, #cca700); }
    .insight--info .insight-icon { color: var(--vscode-charts-blue, var(--vscode-terminal-ansiBlue, #3794ff)); }
    .insight--good .insight-icon { color: var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, #89d185)); }
    .insight-title {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .insight-body {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    /* Collapsible top-level sections */
    .panel-section {
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
      background: rgba(128,128,128,0.04);
    }
    .panel-section + .panel-section {
      margin-top: 4px;
    }
    .panel-section > summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 8px 12px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 700;
      /* Brighter than metric headers: high-contrast foreground (bright on dark
         themes, dark on light themes) vs. the muted descriptionForeground used
         by .section-label */
      color: var(--vscode-foreground);
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
      border-left: 3px solid transparent;
    }
    .panel-section[open] > summary {
      border-left-color: var(--vscode-focusBorder, var(--vscode-activityBarBadge-background, #007acc));
    }
    .panel-section > summary::-webkit-details-marker { display: none; }
    .panel-section > summary:hover { opacity: 0.85; }
    /* Inner chart/kpi blocks shouldn't repeat the section border */
    .panel-section .chart-section,
    .panel-section .kpi-row { border-bottom: none; }

    /* Collapsible metric sub-sections: the label becomes a clickable summary;
       content lives in .chart-body. */
    details.chart-section { padding: 0; }
    details.chart-section > summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 8px 12px 6px;
      margin-bottom: 0;
    }
    details.chart-section > summary::-webkit-details-marker { display: none; }
    details.chart-section > summary:hover { color: var(--vscode-foreground); }
    details.chart-section .chart-body { padding: 0 12px 10px; }

    /* Expand/collapse-all control above the Breakdown sub-sections. */
    .breakdown-divider {
      border: none;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
      margin: 0;
    }
    .breakdown-tools {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 6px 12px 6px;
      margin-bottom: -4px;
    }
    .breakdown-toggle-all {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
    }
    .breakdown-toggle-all:hover { text-decoration: underline; }
    /* Filter pinned to the top-right of a section */
    .section-filter {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: 0 12px 8px;
    }
    .filter-range {
      margin-left: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }
    .section-filter .filter-select {
      position: static;
      top: auto;
      right: auto;
    }
    .section-empty {
      padding: 4px 12px 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Filter controls inlined next to a KPI */
    .kpi-filter {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 3px;
      flex-shrink: 0;
    }
    .kpi-filter .filter-select {
      position: static;
      top: auto;
      right: auto;
      text-align-last: right;
    }
    .kpi-filter .filter-range {
      margin-left: 0;
      text-align: right;
    }
    .kpi-row--top {
      align-items: flex-start;
    }

    /* Custom date-range inputs (shown under the filter when "Custom" is active) */
    .custom-range {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
    }
    .custom-range-sep {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .custom-date {
      background: var(--vscode-input-background, #2a2a2a);
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      font-family: inherit;
      font-size: 10px;
      padding: 1px 4px;
    }

    /* Daily usage line chart */
    .chart-section:not([open]) .usage-peak { display: none; }
    .usage-peak {
      margin-left: auto;
      text-transform: none;
      font-size: 10px;
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }
    .usage-chart-wrap {
      position: relative;
      margin-top: 2px;
      height: 72px;
    }
    .usage-chart { display: block; width: 100%; height: 72px; }
    .usage-line {
      fill: none;
      stroke: var(--vscode-terminal-ansiCyan, #29b8db);
      stroke-width: 1.5;
    }
    .usage-area {
      fill: var(--vscode-terminal-ansiCyan, #29b8db);
      opacity: 0.12;
      stroke: none;
    }
    .usage-marker {
      position: absolute;
      top: 0;
      width: 1px;
      height: 72px;
      background: var(--vscode-descriptionForeground, #888);
      opacity: 0.5;
      display: none;
      pointer-events: none;
    }
    .usage-dot {
      position: absolute;
      width: 6px;
      height: 6px;
      margin: -3px 0 0 -3px;
      border-radius: 50%;
      background: var(--vscode-terminal-ansiCyan, #29b8db);
      display: none;
      pointer-events: none;
    }
    .usage-tip {
      position: absolute;
      top: 0;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
      color: var(--vscode-foreground);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      white-space: nowrap;
      display: none;
      pointer-events: none;
      z-index: 2;
    }
    /* Zoom scrollbar (navigator) */
    .usage-nav {
      position: relative;
      height: 7px;
      margin-top: 6px;
      border-radius: 4px;
      background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.15));
    }
    .usage-nav-thumb {
      position: absolute;
      top: 0;
      height: 100%;
      min-width: 14px;
      border-radius: 4px;
      background: var(--vscode-scrollbarSlider-activeBackground, rgba(128,128,128,0.45));
      cursor: grab;
    }
    .usage-nav-thumb:active { cursor: grabbing; }
    .usage-nav-handle {
      position: absolute;
      top: 0;
      width: 6px;
      height: 100%;
      cursor: ew-resize;
    }
    .usage-nav-handle.left { left: -1px; }
    .usage-nav-handle.right { right: -1px; }

    /* Bar rows */
    .bar-row {
      display: grid;
      /* Wider label column so longer names (e.g. "claude-sonnet-4.6") aren't
         truncated early; the bar track (1fr) stretches with the panel width. The
         value column is a FIXED width (each row is its own grid) so every bar ends
         at the same point and is the same length; the 6px gap is the fixed padding
         between the bar and the value. */
      grid-template-columns: 100px minmax(0, 1fr) 76px;
      align-items: center;
      gap: 6px;
      margin-bottom: 5px;
    }
    .bar-label {
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-track {
      height: 5px;
      background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.2));
      border-radius: 3px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--vscode-terminal-ansiCyan, #29b8db);
      transition: width 0.3s ease;
    }
    .bar-value {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
      font-family: monospace;
      white-space: nowrap;
    }

    /* Sessions list */
    .session-controls {
      display: flex;
      /* Top-align so the metric dropdown / order button sit at the top, level with
         the range label atop the (taller, two-line) date-range filter. */
      align-items: flex-start;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
    }
    /* Date-range filter sits at the top-right of the controls row: range label on
       top, window <select> below it. */
    .session-controls .kpi-filter {
      margin-left: auto;
    }
    /* Metric picker with a row count beneath it. */
    .session-metric-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .session-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: 3px;
    }
    .session-select {
      background: var(--vscode-dropdown-background, transparent);
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      font-size: 11px;
      font-family: inherit;
      padding: 2px 4px;
      cursor: pointer;
      outline: none;
    }
    .session-select option {
      background: var(--vscode-dropdown-background, #1e1e1e);
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    }
    /* Fixed-height scroll area so the controls above (metric/count/date range) and
       the sticky column headers stay visible while the rows scroll. */
    .session-list {
      padding: 4px 12px 10px;
    }
    /* Shared 4-column layout for the header and each row: date · source · title · value.
       Fixed widths on date/source/value keep the header aligned with the rows;
       the title column flexes and ellipsizes. */
    .session-thead,
    .session-summary {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .session-col-date { flex: 0 0 74px; }
    .session-col-source { flex: 0 0 34px; }
    .session-col-title { flex: 1 1 auto; min-width: 0; }
    .session-col-value { flex: 0 0 auto; margin-left: auto; text-align: right; }
    .session-thead {
      padding-bottom: 6px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
    }
    .session-th {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
    }
    .session-th:hover,
    .session-th.active {
      color: var(--vscode-foreground);
    }
    .session-sort-arrow {
      margin-left: 2px;
    }
    .session-row {
      padding: 8px 0;
      cursor: pointer;
    }
    .session-row:hover .session-title {
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    }
    .session-row + .session-row {
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.08));
    }
    .session-date {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .session-title {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Expanded rows show the full title rather than truncating. */
    .session-row.expanded .session-title {
      white-space: normal;
      overflow: visible;
    }
    .session-source {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .session-value {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-family: monospace;
      white-space: nowrap;
    }
    .session-detail {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
    }
    .session-detail-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 11px;
    }
    .session-detail-key {
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .session-detail-val {
      text-align: right;
      font-family: monospace;
      word-break: break-word;
    }

    /* Pace section */
    .pace-projected {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 4px;
    }
    .pace-sub {
      font-size: 10px;
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      letter-spacing: 0;
    }
    .pace-msg {
      font-size: 11px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    .pace-msg.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
    .pace-msg.over { color: var(--vscode-errorForeground, #f44747); }
    .pace-msg.ok   { color: var(--vscode-terminal-ansiGreen, #4ec94e); }

    /* Tracking bar */
    .tracking-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
    }
    .tracking-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .tracking-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-terminal-ansiGreen, #4ec94e);
    }
    .tracking-dot.off {
      background: var(--vscode-descriptionForeground, #888);
      opacity: 0.5;
    }
    .tracking-actions {
      display: flex;
      gap: 4px;
    }
    .tracking-btn {
      background: none;
      border: 1px solid var(--vscode-button-border, transparent);
      cursor: pointer;
      color: var(--vscode-foreground);
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: inherit;
      opacity: 0.65;
    }
    .tracking-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
      opacity: 1;
    }
    /* Gear that opens the options menu — slightly larger glyph, square-ish hit area. */
    .tracking-gear {
      font-size: 14px;
      line-height: 1;
      padding: 2px 6px;
    }

    /* Empty state */
    .empty-state {
      padding: 20px 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    let lastData = null;

    // UI preferences persisted across panel reloads (VS Code tears the webview
    // down when the sidebar is hidden). Restored from getState() on load.
    // breakdownWindow: 'month' (this period) | 'last' (last period) | 0 (all time) | 'custom'.
    const persisted = vscode.getState() || {};
    let breakdownWindow = persisted.breakdownWindow ?? 0;
    let budgetOpen = persisted.budgetOpen ?? true;
    let breakdownOpen = persisted.breakdownOpen ?? false;
    let sessionsOpen = persisted.sessionsOpen ?? false;
    // Collapsed state of each Breakdown sub-section, keyed by id (true = collapsed).
    // Defaults to expanded (absent/false).
    const breakdownCollapsed = persisted.breakdownCollapsed || {};
    // Every collapsible Breakdown sub-section id, for the expand/collapse-all control.
    const BREAKDOWN_SUBSECTIONS = ['daily', 'insights', 'byDayOfWeek', 'byModel', 'tokenBreakdown', 'bySource', 'byRepo'];
    // Sessions list controls: metric to sort by, sort direction, and an
    // independent date-range window (mirrors the Breakdown filter). Defaults to
    // all time so every session is visible without changing the period.
    let sessionMetric = persisted.sessionMetric ?? 'credits'; // 'credits' | 'input' | 'output' (value column)
    let sessionSort = persisted.sessionSort ?? 'metric';      // 'date' | 'source' | 'title' | 'metric' (sort column)
    let sessionOrder = persisted.sessionOrder ?? 'desc';      // 'desc' | 'asc'
    let sessionWindow = persisted.sessionWindow ?? 0;         // 'month' | 'last' | 0 | 'custom'
    let sessionCustomStartMs = persisted.sessionCustomStartMs ?? null;
    let sessionCustomEndMs = persisted.sessionCustomEndMs ?? null;
    // Session rows the user has expanded (by session id). In-memory only — survives
    // re-renders/sync ticks within this view, resets on full reload.
    const expandedSessions = new Set(persisted.expandedSessions || []);
    // Custom range bounds (ms), local day boundaries. Null until the user sets them.
    let customStartMs = persisted.customStartMs ?? null;
    let customEndMs = persisted.customEndMs ?? null;
    function saveUiState() {
      vscode.setState({
        breakdownWindow, budgetOpen, breakdownOpen, sessionsOpen, breakdownCollapsed,
        sessionMetric, sessionSort, sessionOrder, sessionWindow, sessionCustomStartMs, sessionCustomEndMs,
        expandedSessions: Array.from(expandedSessions),
        customStartMs, customEndMs,
      });
    }
    // Billing-period boundaries (ms), supplied by the extension host. Null until first update.
    let periodStartMs = null;
    let periodEndMs = null;
    let lastPeriodStartMs = null;
    let lastPeriodEndMs = null;

    // <input type="date"> uses local "YYYY-MM-DD". Convert to/from a ms boundary.
    function pad2(n) { return String(n).padStart(2, '0'); }
    function msToDateInput(ms) {
      const d = new Date(ms);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    function dateInputToMs(str, endOfDay) {
      const [y, m, d] = str.split('-').map(Number);
      return endOfDay
        ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
        : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const CREDITS_PER_USD = ${CREDITS_PER_USD};
    // Display unit ('credits' | 'dollars'), refreshed from each update. Amounts are
    // always stored in USD; these formatters convert for display only.
    let displayUnit = 'credits';
    function unitLabel() { return displayUnit === 'dollars' ? 'USD' : 'credits'; }
    // Bare KPI/budget number: "$12.34" in dollars, "1,234" in credits.
    function fmtCreditsNum(usd) {
      if (displayUnit === 'dollars') {
        return '$' + usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return (usd * CREDITS_PER_USD).toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    // Amount with a trailing unit word: "$12.34" / "1,234 credits".
    function fmtCredits(usd) {
      return displayUnit === 'dollars' ? fmtCreditsNum(usd) : fmtCreditsNum(usd) + ' credits';
    }
    // Compact form for bar values: "$12.34" / "1,234 crds".
    function fmtCrds(usd) {
      return displayUnit === 'dollars' ? fmtCreditsNum(usd) : fmtCreditsNum(usd) + ' crds';
    }
    // Compact token counts for bar values: "1.2M", "34.5K", "812".
    function fmtTokens(n) {
      n = n || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\\.0$/, '') + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\\.0$/, '') + 'K';
      return String(Math.round(n));
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtModel(m) {
      return m.replace(/-\\d{8}$/, '').replace(/^copilot-/, '');
    }

    function spanDays(allocs) {
      if (allocs.length === 0) return 1;
      const min = Math.min(...allocs.map(a => Date.parse(a.at)));
      const days = (Date.now() - min) / 86400000;
      return Math.max(days, 1);
    }

    // Count how many times a given weekday (0=Sun..6=Sat) appears between startMs and now
    function occurrencesOfWeekday(dayIndex, startMs) {
      const now = new Date();
      const totalDays = Math.max(1, Math.ceil((now.getTime() - startMs) / 86400000));
      const fullWeeks = Math.floor(totalDays / 7);
      const remainder = totalDays % 7;
      let extra = 0;
      for (let i = 0; i < remainder; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        if (d.getDay() === dayIndex) { extra = 1; break; }
      }
      return fullWeeks + extra || 1;
    }

    // Resolve a window selector to a date range. Returns inclusive-start /
    // exclusive-end ms bounds, the last day to draw on the chart axis, and a
    // fixed elapsed-day count for fixed-length windows (null = derive from data).
    function resolveRange(win, cStart, cEnd) {
      cStart = cStart === undefined ? customStartMs : cStart;
      cEnd = cEnd === undefined ? customEndMs : cEnd;
      if (win === 'month') {
        let start = periodStartMs;
        if (start == null) {
          const m = new Date(); m.setDate(1); m.setHours(0, 0, 0, 0); start = m.getTime();
        }
        const end = periodEndMs != null ? periodEndMs : Infinity;
        return { startMs: start, endMs: end, axisEndMs: Date.now(), elapsedDays: Math.max(1, (Date.now() - start) / 86400000) };
      }
      if (win === 'last') {
        if (lastPeriodStartMs == null || lastPeriodEndMs == null) return { startMs: null };
        return {
          startMs: lastPeriodStartMs, endMs: lastPeriodEndMs, axisEndMs: lastPeriodEndMs - 1,
          elapsedDays: Math.max(1, (lastPeriodEndMs - lastPeriodStartMs) / 86400000),
        };
      }
      if (win === 'custom') {
        if (cStart == null || cEnd == null) return { startMs: null };
        const end = cEnd + 1; // cEnd is end-of-day inclusive
        return {
          startMs: cStart, endMs: end, axisEndMs: Math.min(cEnd, Date.now()),
          elapsedDays: Math.max(1, (Math.min(end, Date.now()) - cStart) / 86400000),
        };
      }
      // all time
      return { startMs: 0, endMs: Infinity, axisEndMs: Date.now(), elapsedDays: null };
    }

    function compute(allocations, win, cStart, cEnd) {
      const range = resolveRange(win, cStart, cEnd);

      // Today / this week — always absolute, independent of window toggle
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
      let todaySpent = 0, thisWeekSpent = 0;
      for (const a of (allocations || [])) {
        if (a.provider !== 'copilot') continue;
        const t = Date.parse(a.at);
        if (t >= todayStart.getTime()) todaySpent += a.costUsd;
        if (t >= weekStart.getTime()) thisWeekSpent += a.costUsd;
      }

      // Window bounds unavailable yet (e.g. last/custom before they're set).
      if (range.startMs == null) return { todaySpent, thisWeekSpent, empty: true };

      const allocs = (allocations || []).filter(
        a => a.provider === 'copilot' && Date.parse(a.at) >= range.startMs && Date.parse(a.at) < range.endMs
      );

      if (allocs.length === 0) return { todaySpent, thisWeekSpent, empty: true };

      const totalSpent = allocs.reduce((s, a) => s + a.costUsd, 0);
      const days = range.elapsedDays ?? spanDays(allocs);
      const weeks = Math.max(1, days / 7);

      // KPIs
      const months = Math.max(1, days / 30.44); // avg days per calendar month
      const avgWeekly  = totalSpent / weeks;
      const avgDaily   = totalSpent / days;
      const avgMonthly = totalSpent / months;

      // By day of week
      const dayTotals = [0, 0, 0, 0, 0, 0, 0];
      for (const a of allocs) {
        dayTotals[new Date(a.at).getDay()] += a.costUsd;
      }
      const byDayOfWeek = DAY_NAMES.map((name, i) => ({
        label: name,
        value: dayTotals[i],
      })).filter(r => r.value > 0);

      // By model
      const modelMap = {};
      for (const a of allocs) {
        modelMap[a.model] = (modelMap[a.model] || 0) + a.costUsd;
      }
      const byModel = Object.entries(modelMap)
        .map(([model, total]) => ({ label: fmtModel(model), value: total }))
        .sort((a, b) => b.value - a.value);

      // By repo
      const repoMap = {};
      for (const a of allocs) {
        if (a.repo) repoMap[a.repo] = (repoMap[a.repo] || 0) + a.costUsd;
      }
      const byRepo = Object.entries(repoMap)
        .map(([repo, total]) => ({ label: repo, value: total }))
        .sort((a, b) => b.value - a.value);

      // By source (Copilot Chat vs CLI). Classify from the explicit source field,
      // falling back to the externalId namespace for legacy/untagged entries.
      const SOURCE_LABEL = { chat: 'Chat', cli: 'CLI' };
      const srcOf = (a) => (a.source === 'cli' || a.source === 'chat')
        ? a.source
        : (a.externalId && a.externalId.indexOf('copilot-cli-') === 0 ? 'cli' : 'chat');
      const sourceMap = {};
      for (const a of allocs) {
        const s = srcOf(a);
        sourceMap[s] = (sourceMap[s] || 0) + a.costUsd;
      }
      const bySource = Object.entries(sourceMap)
        .map(([s, total]) => ({ label: SOURCE_LABEL[s] || s, value: total }))
        .sort((a, b) => b.value - a.value);

      // Cache write/read is a CLI-only metric. Gate the Cache section on whether the
      // config holds any CLI logs at all (not just this window), so pure-Chat users
      // never see a cache section that could only ever be empty for them.
      const hasCli = (allocations || []).some(a => a.provider === 'copilot' && srcOf(a) === 'cli');

      // Daily series for the line chart: contiguous, zero-filled days from the
      // window start to its axis end. All time starts at the earliest allocation.
      const dayKey = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
      const axisStartMs = win === 0 ? Math.min(...allocs.map(a => Date.parse(a.at))) : range.startMs;
      const axisEndKey = dayKey(range.axisEndMs);
      const dayMap = {};
      for (const a of allocs) {
        const k = dayKey(Date.parse(a.at));
        dayMap[k] = (dayMap[k] || 0) + a.costUsd;
      }
      const daily = [];
      const cur = new Date(axisStartMs); cur.setHours(0, 0, 0, 0);
      let guard = 0;
      while (cur.getTime() <= axisEndKey && guard++ < 4000) {
        const k = cur.getTime();
        daily.push({ t: k, value: dayMap[k] || 0 });
        cur.setDate(cur.getDate() + 1);
      }

      // By session. Group allocations by session id (new entries carry it; legacy
      // entries fall back to the externalId). Accumulate cost + tokens (plus the
      // fields needed for the expandable detail), and pick a readable label: the
      // scraped chat title, else repo · shortId · model.
      const sessAcc = {};
      for (const a of allocs) {
        const key = a.sessionId || a.externalId || 'unknown';
        let s = sessAcc[key];
        if (!s) {
          const shortId = String(a.sessionId || key).replace(/^copilot-(chat|cli)-/, '').slice(0, 6);
          const fallback = (a.repo ? a.repo + ' · ' : '') + shortId + ' · ' + fmtModel(a.model);
          s = sessAcc[key] = {
            id: String(key), shortId, label: a.title || fallback, hasTitle: !!a.title,
            source: srcOf(a), repo: a.repo || null, models: {}, atMs: 0,
            cost: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0,
          };
        }
        if (a.title && !s.hasTitle) { s.label = a.title; s.hasTitle = true; }
        if (!s.repo && a.repo) s.repo = a.repo;
        if (a.model) s.models[fmtModel(a.model)] = true;
        const t = Date.parse(a.at);
        if (Number.isFinite(t) && t > s.atMs) s.atMs = t;
        s.cost += a.costUsd;
        s.input += a.inputTokens || 0;
        s.output += a.outputTokens || 0;
        // Chat allocations carry null cache counts (no breakdown); sum as 0. The
        // detail view shows these rows only for CLI sessions.
        s.cacheCreation += a.cacheCreationTokens || 0;
        s.cacheRead += a.cacheReadTokens || 0;
      }
      const sessions = Object.keys(sessAcc).map(k => sessAcc[k]);

      // Token totals across the window (treat nulls as 0). Cache write/read come only
      // from CLI sessions; Chat allocations contribute 0.
      const tokenTotals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      for (const a of allocs) {
        tokenTotals.input += a.inputTokens || 0;
        tokenTotals.output += a.outputTokens || 0;
        tokenTotals.cacheCreation += a.cacheCreationTokens || 0;
        tokenTotals.cacheRead += a.cacheReadTokens || 0;
      }

      // Optimization insights — short heuristic hints. Each is a structured card
      // ({ tone, icon, title, body }) so the UI can style by severity. Thresholds
      // are tunable.
      const HOTSPOT_SHARE = 0.70, EXPENSIVE_FACTOR = 2;
      const insights = [];
      if (byModel.length && byModel[0].value / totalSpent >= HOTSPOT_SHARE) {
        insights.push({
          tone: 'info', icon: '◆', title: 'Model hotspot',
          body: byModel[0].label + ' drives ' + (byModel[0].value / totalSpent * 100).toFixed(0) + '% of spend.',
        });
      }
      if (byRepo.length && byRepo[0].value / totalSpent >= HOTSPOT_SHARE) {
        insights.push({
          tone: 'info', icon: '❖', title: 'Repo hotspot',
          body: byRepo[0].label + ' accounts for ' + (byRepo[0].value / totalSpent * 100).toFixed(0) + '% of spend.',
        });
      }
      const ratios = sessions.filter(s => s.output > 0).map(s => s.cost / (s.output / 1000));
      if (ratios.length >= 3) {
        const sorted = ratios.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const top = sessions.slice().sort((a, b) => b.cost - a.cost)[0];
        if (top && top.output > 0 && median > 0 &&
            top.cost / (top.output / 1000) > median * EXPENSIVE_FACTOR) {
          insights.push({
            tone: 'warn', icon: '⚠', title: 'Expensive session',
            body: '“' + top.label + '” spends a lot relative to its output — ' +
              'consider a smaller model or a tighter prompt.',
          });
        }
      }
      const insightsTop = insights.slice(0, 3);

      return {
        todaySpent, thisWeekSpent, totalSpent, avgWeekly, avgDaily, avgMonthly,
        byDayOfWeek, byModel, byRepo, bySource, daily, sessions,
        tokenTotals, hasCli, insights: insightsTop,
      };
    }

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function fmtMonthDay(date) {
      return MONTH_NAMES[date.getMonth()] + ' ' + date.getDate();
    }

    function fmtMDY(date) {
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return m + '/' + d + '/' + date.getFullYear();
    }

    function fmtYMD(date) {
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return date.getFullYear() + '/' + m + '/' + d;
    }

    function ordinal(n) {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    function computePace(avgDaily, monthlyBudgetUsd, monthlySpentUsd) {
      if (!avgDaily || avgDaily <= 0) return null;
      const now = new Date();
      // Period end = next renewal; fall back to end of calendar month if unknown.
      const endOfMonth = periodEndMs != null
        ? new Date(periodEndMs)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      const daysRemaining = Math.max(0, (endOfMonth.getTime() - now.getTime()) / 86400000);
      const projectedTotal = (monthlySpentUsd || 0) + avgDaily * daysRemaining;

      if (monthlyBudgetUsd > 0) {
        if ((monthlySpentUsd || 0) >= monthlyBudgetUsd) {
          return { type: 'already-over', projectedTotal, endOfMonth };
        }
        const remainingBudget = monthlyBudgetUsd - (monthlySpentUsd || 0);
        const daysUntilExceeded = remainingBudget / avgDaily;
        const exceededDate = new Date(now.getTime() + daysUntilExceeded * 86400000);
        if (daysUntilExceeded <= daysRemaining) {
          return { type: 'will-exceed', projectedTotal, exceededDate, daysUntilExceeded, endOfMonth };
        }
        return { type: 'under', projectedTotal, endOfMonth };
      }
      return { type: 'no-budget', projectedTotal, endOfMonth };
    }

    function renderBars(rows, fmt) {
      fmt = fmt || fmtCrds;
      if (!rows || rows.length === 0) return '<div class="bar-row"><span class="bar-label" style="color:var(--vscode-descriptionForeground)">No data</span></div>';
      const total = rows.reduce((s, r) => s + r.value, 0);
      return rows.map(r => {
        const pct = total > 0 ? (r.value / total * 100).toFixed(1) : '0';
        return \`
          <div class="bar-row">
            <span class="bar-label" title="\${esc(r.label)}">\${esc(r.label)}</span>
            <div class="bar-track">
              <div class="bar-fill" data-pct="\${pct}"></div>
            </div>
            <span class="bar-value">\${esc(fmt(r.value))}</span>
          </div>
        \`;
      }).join('');
    }

    function barColor(pct) {
      if (pct >= 0.9) return 'red';
      if (pct >= 0.7) return 'yellow';
      return 'green';
    }

    // Sessions list: a 4-column table (Date · Source · Title · metric value).
    // Headers are clickable to choose the sort column; clicking the active column
    // again flips direction. The metric column shows whichever metric the dropdown
    // selects. Rows expand to a detail view on click.
    const SESSION_METRIC_VALUE = {
      credits: s => s.cost,
      input: s => s.input,
      output: s => s.output,
    };
    const SESSION_METRIC_LABEL = { credits: 'Credits', input: 'Input', output: 'Output' };
    function sessionMetricFmt(metric) {
      return metric === 'credits' ? fmtCrds : fmtTokens;
    }
    function renderSessionList(sessions, metric) {
      const pick = SESSION_METRIC_VALUE[metric] || SESSION_METRIC_VALUE.credits;
      const fmt = sessionMetricFmt(metric);
      const rows = (sessions || [])
        .map(s => ({ s, value: pick(s) }))
        .filter(r => r.value > 0);
      if (rows.length === 0) return '<div class="section-empty">No session data for this period.</div>';

      // Sort by the active column; string columns case-insensitive, others numeric.
      const cmp = {
        date: (a, b) => a.s.atMs - b.s.atMs,
        source: (a, b) => String(a.s.source).localeCompare(String(b.s.source)),
        title: (a, b) => String(a.s.label).toLowerCase().localeCompare(String(b.s.label).toLowerCase()),
        metric: (a, b) => a.value - b.value,
      };
      const sortFn = cmp[sessionSort] || cmp.metric;
      const dir = sessionOrder === 'asc' ? 1 : -1;
      rows.sort((a, b) => dir * sortFn(a, b));

      // Sort indicator on the active header.
      const arrow = (col) => sessionSort === col ? \`<span class="session-sort-arrow">\${sessionOrder === 'asc' ? '↑' : '↓'}</span>\` : '';
      const th = (col, label, extra) => \`<span class="session-th \${extra || ''}\${sessionSort === col ? ' active' : ''}" data-sort="\${col}">\${esc(label)}\${arrow(col)}</span>\`;
      const header = \`
        <div class="session-thead">
          \${th('date', 'Date', 'session-col-date')}
          \${th('source', 'Source', 'session-col-source')}
          \${th('title', 'Title', 'session-col-title')}
          \${th('metric', SESSION_METRIC_LABEL[metric] || 'Value', 'session-col-value')}
        </div>
      \`;

      const body = rows.map(r => {
        const s = r.s;
        const expanded = expandedSessions.has(s.id);
        const srcLabel = s.source === 'cli' ? 'CLI' : 'Chat';
        const date = s.atMs ? fmtYMD(new Date(s.atMs)) : '—';
        return \`
          <div class="session-row\${expanded ? ' expanded' : ''}" data-session-id="\${esc(s.id)}">
            <div class="session-summary">
              <span class="session-col-date session-date">\${esc(date)}</span>
              <span class="session-col-source session-source">\${srcLabel}</span>
              <span class="session-col-title session-title" title="\${esc(s.label)}">\${esc(s.label)}</span>
              <span class="session-col-value session-value">\${esc(fmt(r.value))}</span>
            </div>
            \${expanded ? renderSessionDetail(s) : ''}
          </div>
        \`;
      }).join('');

      return header + body;
    }

    // Expanded detail for a session row: a labelled key/value list.
    function renderSessionDetail(s) {
      const models = Object.keys(s.models || {});
      const detail = [
        ['Date', s.atMs ? new Date(s.atMs).toLocaleString() : '—'],
        ['Credits', fmtCredits(s.cost)],
        ['Input', fmtTokens(s.input) + ' tokens'],
        ['Output', fmtTokens(s.output) + ' tokens'],
        // Cache write/read is a CLI-only metric — Chat sessions never persist a cache
        // breakdown, so those rows are omitted rather than shown as "not reported".
        ...(s.source === 'cli'
          ? [['Cache write', fmtTokens(s.cacheCreation) + ' tokens'],
             ['Cache read', fmtTokens(s.cacheRead) + ' tokens']]
          : []),
        ['Source', s.source === 'cli' ? 'CLI' : 'Chat'],
        ['Repo', s.repo || '—'],
        ['Model', models.length ? models.join(', ') : '—'],
        ['Session', s.shortId],
      ];
      return '<div class="session-detail">' + detail.map(kv => \`
        <div class="session-detail-row">
          <span class="session-detail-key">\${esc(kv[0])}</span>
          <span class="session-detail-val">\${esc(kv[1])}</span>
        </div>
      \`).join('') + '</div>';
    }

    // Daily usage line chart. viewBox height == rendered height so the hover
    // overlay (pixel space) maps 1:1 vertically; width stretches to the panel.
    const CHART_W = 300, CHART_H = 72, CHART_PAD = 6;
    const MIN_SPAN = 7; // fewest visible days the zoom window may shrink to
    let lastDaily = null;        // full series backing the most recent chart
    let zoomStart = 0, zoomEnd = 0; // inclusive indices into lastDaily (visible window)
    let zoomKey = null;          // identity of the current series; zoom resets when it changes

    function chartMax(slice) {
      return Math.max(1e-9, ...slice.map(d => d.value));
    }
    function chartY(value, max) {
      return CHART_PAD + (1 - value / max) * (CHART_H - CHART_PAD * 2);
    }

    // Build the line + area path strings for a slice of the daily series.
    function buildPaths(slice) {
      const n = slice.length;
      const max = chartMax(slice);
      const xOf = i => n === 1 ? CHART_W / 2 : (i / (n - 1)) * CHART_W;
      const yOf = v => chartY(v, max);
      let line, area;
      if (n === 1) {
        const y = yOf(slice[0].value).toFixed(2);
        line = \`M0,\${y} L\${CHART_W},\${y}\`;
        area = \`M0,\${CHART_H} L0,\${y} L\${CHART_W},\${y} L\${CHART_W},\${CHART_H} Z\`;
      } else {
        const pts = slice.map((d, i) => \`\${xOf(i).toFixed(2)},\${yOf(d.value).toFixed(2)}\`);
        line = 'M' + pts.join(' L');
        area = \`M\${xOf(0).toFixed(2)},\${CHART_H} L\` + pts.join(' L') + \` L\${xOf(n - 1).toFixed(2)},\${CHART_H} Z\`;
      }
      return { line, area, max };
    }

    // Reset the zoom window to the full range when the series identity changes;
    // otherwise clamp the existing window to the (possibly new) length.
    function reconcileZoom(daily) {
      const n = daily.length;
      const key = n + ':' + daily[0].t + ':' + daily[n - 1].t;
      if (key !== zoomKey) {
        zoomKey = key;
        zoomStart = 0;
        zoomEnd = n - 1;
      } else {
        zoomEnd = Math.min(zoomEnd, n - 1);
        zoomStart = Math.max(0, Math.min(zoomStart, zoomEnd));
      }
    }

    function renderUsageChart(daily) {
      if (!daily || daily.length === 0) return '';
      reconcileZoom(daily);
      const n = daily.length;
      const slice = daily.slice(zoomStart, zoomEnd + 1);
      const { line, area } = buildPaths(slice);
      const peak = Math.max(...slice.map(d => d.value));
      const nav = (breakdownWindow !== 'month' && n > MIN_SPAN) ? \`
            <div class="usage-nav">
              <div class="usage-nav-thumb">
                <div class="usage-nav-handle left"></div>
                <div class="usage-nav-handle right"></div>
              </div>
            </div>\` : '';

      return \`
        <details class="chart-section" data-subsection="daily" \${breakdownCollapsed['daily'] ? '' : 'open'}>
          <summary class="section-label">Daily usage <span class="usage-peak">peak \${esc(fmtCredits(peak))}</span></summary>
          <div class="chart-body">
            <div class="usage-chart-wrap">
              <svg class="usage-chart" viewBox="0 0 \${CHART_W} \${CHART_H}" width="100%" height="\${CHART_H}" preserveAspectRatio="none">
                <path class="usage-area" d="\${area}" />
                <path class="usage-line" d="\${line}" vector-effect="non-scaling-stroke" />
              </svg>
              <div class="usage-marker"></div>
              <div class="usage-dot"></div>
              <div class="usage-tip"></div>
            </div>\${nav}
          </div>
        </details>
      \`;
    }

    // Attach hover + zoom-drag handlers to the freshly-rendered chart each render
    // (so mouseleave fires reliably; the previous element is discarded with innerHTML).
    function wireUsageChart(daily) {
      lastDaily = daily && daily.length ? daily : null;
      const wrap = root.querySelector('.usage-chart-wrap');
      if (!wrap || !lastDaily) return;
      reconcileZoom(lastDaily);

      const areaEl = wrap.querySelector('.usage-area');
      const lineEl = wrap.querySelector('.usage-line');
      const peakEl = root.querySelector('.usage-peak');
      const marker = wrap.querySelector('.usage-marker');
      const dot = wrap.querySelector('.usage-dot');
      const tip = wrap.querySelector('.usage-tip');
      const nav = root.querySelector('.usage-nav');
      const thumb = nav && nav.querySelector('.usage-nav-thumb');

      let visSlice = lastDaily.slice(zoomStart, zoomEnd + 1);
      let visMax = chartMax(visSlice);

      // Redraw the visible slice + reposition the nav thumb (no full re-render).
      function updateZoom() {
        visSlice = lastDaily.slice(zoomStart, zoomEnd + 1);
        visMax = chartMax(visSlice);
        const { line, area } = buildPaths(visSlice);
        areaEl.setAttribute('d', area);
        lineEl.setAttribute('d', line);
        if (peakEl) peakEl.textContent = 'peak ' + fmtCredits(Math.max(...visSlice.map(d => d.value)));
        if (thumb) {
          const n = lastDaily.length;
          thumb.style.left = (zoomStart / (n - 1) * 100) + '%';
          thumb.style.width = ((zoomEnd - zoomStart) / (n - 1) * 100) + '%';
        }
      }
      updateZoom();

      // --- Hover (maps within the visible slice) ---
      const hide = () => {
        marker.style.display = 'none';
        dot.style.display = 'none';
        tip.style.display = 'none';
      };
      wrap.addEventListener('mousemove', e => {
        const rect = wrap.getBoundingClientRect();
        if (rect.width === 0) return;
        const vn = visSlice.length;
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const i = vn === 1 ? 0 : Math.round(frac * (vn - 1));
        const d = visSlice[i];
        const px = vn === 1 ? rect.width / 2 : (i / (vn - 1)) * rect.width;
        const py = chartY(d.value, visMax);

        marker.style.left = px + 'px';
        marker.style.display = 'block';
        dot.style.left = px + 'px';
        dot.style.top = py + 'px';
        dot.style.display = 'block';

        tip.textContent = fmtMonthDay(new Date(d.t)) + ' · ' + fmtCredits(d.value);
        tip.style.display = 'block';
        const left = Math.max(0, Math.min(px - tip.offsetWidth / 2, rect.width - tip.offsetWidth));
        tip.style.left = left + 'px';
      });
      wrap.addEventListener('mouseleave', hide);

      // --- Zoom scrollbar drag ---
      if (nav && thumb) {
        const n = lastDaily.length;
        const startDrag = (mode) => (e) => {
          e.preventDefault();
          const navW = nav.getBoundingClientRect().width;
          const startX = e.clientX;
          const origStart = zoomStart, origEnd = zoomEnd, span = origEnd - origStart;

          const onMove = (ev) => {
            const deltaIdx = Math.round((ev.clientX - startX) / navW * (n - 1));
            if (mode === 'pan') {
              let s = Math.max(0, Math.min(origStart + deltaIdx, n - 1 - span));
              zoomStart = s;
              zoomEnd = s + span;
            } else if (mode === 'left') {
              zoomStart = Math.max(0, Math.min(origStart + deltaIdx, origEnd - MIN_SPAN));
            } else {
              zoomEnd = Math.min(n - 1, Math.max(origEnd + deltaIdx, origStart + MIN_SPAN));
            }
            updateZoom();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };

        thumb.addEventListener('mousedown', startDrag('pan'));
        thumb.querySelector('.usage-nav-handle.left').addEventListener('mousedown', (e) => {
          e.stopPropagation(); startDrag('left')(e);
        });
        thumb.querySelector('.usage-nav-handle.right').addEventListener('mousedown', (e) => {
          e.stopPropagation(); startDrag('right')(e);
        });
      }
    }

    function render(data) {
      if (!data) return;
      lastData = data;
      const { allocations, copilotEnabled, monthlyBudgetUsd, monthlySpentUsd, renewalDay } = data;
      displayUnit = data.displayUnit === 'dollars' ? 'dollars' : 'credits';
      periodStartMs = data.periodStart ? Date.parse(data.periodStart) : null;
      periodEndMs = data.periodEnd ? Date.parse(data.periodEnd) : null;
      lastPeriodStartMs = data.lastPeriodStart ? Date.parse(data.lastPeriodStart) : null;
      lastPeriodEndMs = data.lastPeriodEnd ? Date.parse(data.lastPeriodEnd) : null;

      const renewalSub = renewalDay != null
        ? \`<span class="pace-sub"><span class="edit-label" data-action="setRenewalDate" title="Edit reset date">Resets on the \${ordinal(renewalDay)}</span></span>\`
        : \`<span class="pace-sub"><span class="edit-label unset" data-action="setRenewalDate">set reset date</span></span>\`;

      let monthlyHtml;
      if (monthlyBudgetUsd != null && monthlyBudgetUsd > 0) {
        const mPct = monthlySpentUsd / monthlyBudgetUsd;
        const mPctClamped = Math.min(mPct, 1);
        const mColor = barColor(mPct);
        monthlyHtml = \`
          <div class="chart-section">
            <div class="section-label"><span class="edit-label" data-action="setMonthlyBudget" title="Edit monthly budget">Monthly Budget</span></div>
            <div class="pace-projected budget-amount">\${fmtCredits(monthlyBudgetUsd)} \${renewalSub}</div>
            <div class="progress-track" style="margin:6px 0 0">
              <div class="progress-fill \${mColor}" data-pct="\${(mPctClamped * 100).toFixed(1)}"></div>
            </div>
            <div class="monthly-meta">
              <span>\${fmtCredits(monthlySpentUsd)} spent</span>
              <span>\${(mPct * 100).toFixed(0)}% used</span>
            </div>
          </div>
        \`;
      } else {
        monthlyHtml = \`
          <div class="chart-section">
            <div class="section-label"><span class="edit-label" data-action="setMonthlyBudget" title="Edit monthly budget">Monthly Budget</span></div>
            <div class="monthly-prompt"><a data-action="setMonthlyBudget">Set a monthly budget</a></div>
            <div class="monthly-meta">\${renewalSub}</div>
          </div>
        \`;
      }

      const trackingBar = \`
        <div class="tracking-bar">
          <div class="tracking-status">
            <div class="tracking-dot \${copilotEnabled ? '' : 'off'}"></div>
            \${copilotEnabled ? 'Tracking enabled' : 'Tracking disabled'}
          </div>
          <div class="tracking-actions">
            <button class="tracking-btn tracking-gear" data-action="showMenu" title="Options" aria-label="Options">⚙</button>
          </div>
        </div>
      \`;

      const statsBreak = compute(allocations || [], breakdownWindow);
      // Pace always reflects the current month, independent of the section filter.
      const statsMonth = breakdownWindow === 'month' ? statsBreak : compute(allocations || [], 'month');
      // Sessions list uses its own independent window.
      const statsSession = compute(allocations || [], sessionWindow, sessionCustomStartMs, sessionCustomEndMs);

      function rangeLabel(win, cStart, cEnd) {
        cStart = cStart === undefined ? customStartMs : cStart;
        cEnd = cEnd === undefined ? customEndMs : cEnd;
        let startMs, endMs;
        if (win === 'month') {
          if (periodStartMs == null) return '';
          startMs = periodStartMs;
          endMs = periodEndMs ?? Date.now();
        } else if (win === 'last') {
          if (lastPeriodStartMs == null) return '';
          startMs = lastPeriodStartMs;
          endMs = lastPeriodEndMs;
        } else if (win === 'custom') {
          if (cStart == null || cEnd == null) return '';
          startMs = cStart;
          endMs = cEnd;
        } else {
          const times = (allocations || [])
            .filter(a => a.provider === 'copilot')
            .map(a => Date.parse(a.at));
          if (times.length === 0) return '';
          startMs = Math.min(...times);
          endMs = Date.now();
        }
        return fmtMDY(new Date(startMs)) + ' – ' + fmtMDY(new Date(endMs));
      }

      // Option list for the breakdown window <select>, marking the active one.
      function windowOptions(value) {
        const opt = (v, label) => \`<option value="\${v}" \${String(value) === v ? 'selected' : ''}>\${label}</option>\`;
        return opt('month', 'This period') + opt('last', 'Last period') + opt('0', 'All time') + opt('custom', 'Custom…');
      }

      // Two date inputs shown only when the custom window is active. The scope arg
      // tags which section the inputs belong to so the change handler routes correctly.
      function customRangeHtml(win, cStart, cEnd, scope) {
        win = win === undefined ? breakdownWindow : win;
        cStart = cStart === undefined ? customStartMs : cStart;
        cEnd = cEnd === undefined ? customEndMs : cEnd;
        scope = scope || 'breakdown';
        if (win !== 'custom') return '';
        const s = cStart != null ? msToDateInput(cStart) : '';
        const e = cEnd != null ? msToDateInput(cEnd) : '';
        return \`
          <div class="custom-range">
            <input type="date" class="custom-date" data-scope="\${scope}" data-custom="start" value="\${s}" aria-label="Start date" />
            <span class="custom-range-sep">–</span>
            <input type="date" class="custom-date" data-scope="\${scope}" data-custom="end" value="\${e}" aria-label="End date" />
          </div>
        \`;
      }

      const fixedKpiHtml = \`
        <div class="kpi-row">
          <div class="kpi">
            <div class="kpi-label">Today</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsMonth.todaySpent))}</div>
            <div class="kpi-sub">\${unitLabel()}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">This week</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsMonth.thisWeekSpent))}</div>
            <div class="kpi-sub">\${unitLabel()} (since Monday)</div>
          </div>
        </div>
      \`;

      const breakdownRange = rangeLabel(breakdownWindow);
      // Single billing periods (this/last) have no meaningful monthly average.
      const singlePeriod = breakdownWindow === 'month' || breakdownWindow === 'last';
      // Filter row always renders (so the window can be changed even when the
      // selected range has no data); Total spent shows a dash when empty.
      const filterTopHtml = \`
        <div class="kpi-row kpi-row--top">
          <div class="kpi">
            <div class="kpi-label">Total spent</div>
            <div class="kpi-value">\${statsBreak.empty ? '–' : esc(fmtCreditsNum(statsBreak.totalSpent))}</div>
            <div class="kpi-sub">\${statsBreak.empty ? '&nbsp;' : unitLabel()}</div>
          </div>
          <div class="kpi-filter">
            \${breakdownWindow === 'custom'
              ? customRangeHtml()
              : (breakdownRange ? \`<span class="filter-range">\${esc(breakdownRange)}</span>\` : '')}
            <select class="filter-select" data-filter="breakdown">
              \${windowOptions(breakdownWindow)}
            </select>
          </div>
        </div>
      \`;
      const avgKpiHtml = statsBreak.empty ? '' : \`
        <div class="kpi-row">
          <div class="kpi">
            <div class="kpi-label">Avg daily</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsBreak.avgDaily))}</div>
            <div class="kpi-sub">\${unitLabel()}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Avg weekly</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsBreak.avgWeekly))}</div>
            <div class="kpi-sub">\${unitLabel()}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Avg monthly</div>
            <div class="kpi-value">\${singlePeriod ? '-' : esc(fmtCreditsNum(statsBreak.avgMonthly))}</div>
            <div class="kpi-sub">\${singlePeriod ? '&nbsp;' : unitLabel()}</div>
          </div>
        </div>
      \`;

      const pace = statsMonth.empty ? null : computePace(statsMonth.avgDaily, monthlyBudgetUsd, monthlySpentUsd);
      let paceHtml = '';
      if (pace) {
        let msgClass = '';
        let msg = '';
        if (pace.type === 'already-over') {
          msgClass = 'over';
          msg = 'Budget exceeded';
        } else if (pace.type === 'will-exceed') {
          msgClass = 'warn';
          const days = Math.max(1, Math.round(pace.daysUntilExceeded));
          msg = \`On track to exceed budget in ~\${days} day\${days === 1 ? '' : 's'}\`;
        } else if (pace.type === 'under') {
          msgClass = 'ok';
          msg = 'On track to stay under budget';
        } else {
          msg = \`Projected spend by \${fmtMonthDay(pace.endOfMonth)}\`;
        }
        paceHtml = \`
          <div class="chart-section">
            <div class="section-label">Pace</div>
            <div class="pace-projected">\${esc(fmtCredits(pace.projectedTotal))} <span class="pace-sub">projected this period</span></div>
            <div class="pace-msg \${msgClass}">\${esc(msg)}</div>
          </div>
        \`;
      }

      // A collapsible metric sub-section: clickable label (with chevron) + body.
      const sub = (id, label, body) => \`
        <details class="chart-section" data-subsection="\${id}" \${breakdownCollapsed[id] ? '' : 'open'}>
          <summary class="section-label">\${label}</summary>
          <div class="chart-body">\${body}</div>
        </details>
      \`;
      const emptyMsg = breakdownWindow === 'custom' ? 'No data for this range.' : 'No data for this period.';
      const insightsBody = \`
        <div class="insights-list">
          \${(statsBreak.insights || []).map(i => \`
            <div class="insight insight--\${i.tone}">
              <span class="insight-icon">\${esc(i.icon)}</span>
              <div class="insight-text">
                <div class="insight-title">\${esc(i.title)}</div>
                <div class="insight-body">\${esc(i.body)}</div>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
      // statsBreak.empty omits tokenTotals, so build this lazily — template literals
      // evaluate eagerly and breakdownHtml's empty branch wouldn't save us from the
      // property access below.
      const tokenBody = statsBreak.empty ? '' : \`
        \${renderBars([
          { label: 'Input', value: statsBreak.tokenTotals.input },
          { label: 'Output', value: statsBreak.tokenTotals.output },
        ].filter(r => r.value > 0), fmtTokens)}
      \`;
      // Cache write/read is a CLI-only metric (Chat sessions persist no breakdown),
      // so it lives in its own section, shown only when the config holds CLI logs.
      const cacheBody = statsBreak.empty ? '' : \`
        \${renderBars([
          { label: 'Cache write', value: statsBreak.tokenTotals.cacheCreation },
          { label: 'Cache read', value: statsBreak.tokenTotals.cacheRead },
        ].filter(r => r.value > 0), fmtTokens)}
      \`;
      const breakdownHtml = statsBreak.empty ? \`<div class="section-empty">\${emptyMsg}</div>\` : \`
        <hr class="breakdown-divider">
        <div class="breakdown-tools">
          <span class="breakdown-toggle-all" data-breakdown-expand>Expand all</span>
          <span class="breakdown-toggle-all" data-breakdown-collapse>Collapse all</span>
        </div>
        \${renderUsageChart(statsBreak.daily)}
        \${statsBreak.insights && statsBreak.insights.length ? sub('insights', 'Insights', insightsBody) : ''}
        \${sub('byDayOfWeek', 'By day of week', renderBars(statsBreak.byDayOfWeek))}
        \${sub('byModel', 'By model', renderBars(statsBreak.byModel))}
        \${sub('tokenBreakdown', 'Token breakdown', tokenBody)}
        \${statsBreak.hasCli ? sub('cache', 'Cache (CLI Only)', cacheBody) : ''}
        \${statsBreak.bySource && statsBreak.bySource.length > 1 ? sub('bySource', 'By source', renderBars(statsBreak.bySource)) : ''}
        \${statsBreak.byRepo && statsBreak.byRepo.length > 0 ? sub('byRepo', 'By repo', renderBars(statsBreak.byRepo)) : ''}
      \`;

      const budgetSection = \`
        <details class="panel-section" data-section="budget" \${budgetOpen ? 'open' : ''}>
          <summary>Usage &amp; Pace</summary>
          \${monthlyHtml}
          \${fixedKpiHtml}
          \${paceHtml}
        </details>
      \`;

      const breakdownSection = \`
        <details class="panel-section" data-section="breakdown" \${breakdownOpen ? 'open' : ''}>
          <summary>Breakdown</summary>
          \${filterTopHtml}
          \${avgKpiHtml}
          \${breakdownHtml}
        </details>
      \`;

      const metricOpt = (v, label) => \`<option value="\${v}"\${sessionMetric === v ? ' selected' : ''}>\${label}</option>\`;
      const sessionRange = rangeLabel(sessionWindow, sessionCustomStartMs, sessionCustomEndMs);
      const sessionEmptyMsg = sessionWindow === 'custom' ? 'No session data for this range.' : 'No session data for this period.';
      const sessionPick = SESSION_METRIC_VALUE[sessionMetric] || SESSION_METRIC_VALUE.credits;
      const sessionCount = statsSession.empty ? 0 : (statsSession.sessions || []).filter(s => sessionPick(s) > 0).length;
      // Metric picker (left) and the date-range filter (top-right) share one row;
      // sorting is driven by the clickable column headers in the list below.
      const sessionsHtml = \`
        <div class="session-controls">
          <div class="session-metric-group">
            <select class="session-select">
              \${metricOpt('credits', 'Credits')}
              \${metricOpt('input', 'Input')}
              \${metricOpt('output', 'Output')}
            </select>
            <span class="session-count">\${sessionCount} \${sessionCount === 1 ? 'session' : 'sessions'}</span>
          </div>
          <div class="kpi-filter">
            \${sessionWindow === 'custom'
              ? customRangeHtml(sessionWindow, sessionCustomStartMs, sessionCustomEndMs, 'sessions')
              : (sessionRange ? \`<span class="filter-range">\${esc(sessionRange)}</span>\` : '')}
            <select class="filter-select" data-filter="sessions">
              \${windowOptions(sessionWindow)}
            </select>
          </div>
        </div>
        \${statsSession.empty
          ? \`<div class="section-empty">\${sessionEmptyMsg}</div>\`
          : \`<div class="session-list">\${renderSessionList(statsSession.sessions, sessionMetric)}</div>\`}
      \`;

      const sessionsSection = \`
        <details class="panel-section" data-section="sessions" \${sessionsOpen ? 'open' : ''}>
          <summary>Sessions</summary>
          \${sessionsHtml}
        </details>
      \`;

      root.innerHTML = trackingBar + budgetSection + breakdownSection + sessionsSection;

      applyBarWidths();
      wireUsageChart(statsBreak.daily);
    }

    function applyBarWidths() {
      root.querySelectorAll('.bar-fill[data-pct], .progress-fill[data-pct]').forEach(el => {
        el.style.width = el.dataset.pct + '%';
      });
    }

    root.addEventListener('change', e => {
      const ssel = e.target.closest('.session-select');
      if (ssel) {
        sessionMetric = ssel.value;
        saveUiState();
        render(lastData);
        return;
      }

      const sel = e.target.closest('.filter-select');
      if (sel) {
        const win = sel.value === '0' ? 0 : sel.value;
        // Seed a sensible default range (last 30 days) the first time Custom is chosen.
        const seedCustom = (s, en) => {
          if (win === 'custom' && (s == null || en == null)) {
            const end = new Date(); end.setHours(23, 59, 59, 999);
            const start = new Date(); start.setDate(start.getDate() - 29); start.setHours(0, 0, 0, 0);
            return [start.getTime(), end.getTime()];
          }
          return [s, en];
        };
        if (sel.dataset.filter === 'sessions') {
          sessionWindow = win;
          [sessionCustomStartMs, sessionCustomEndMs] = seedCustom(sessionCustomStartMs, sessionCustomEndMs);
        } else {
          breakdownWindow = win;
          [customStartMs, customEndMs] = seedCustom(customStartMs, customEndMs);
        }
        saveUiState();
        render(lastData);
        return;
      }

      const dateInput = e.target.closest('.custom-date');
      if (dateInput && dateInput.value) {
        const sessions = dateInput.dataset.scope === 'sessions';
        const ms = dateInputToMs(dateInput.value, dateInput.dataset.custom === 'end');
        let start = sessions ? sessionCustomStartMs : customStartMs;
        let end = sessions ? sessionCustomEndMs : customEndMs;
        if (dateInput.dataset.custom === 'start') start = ms; else end = ms;
        // Keep start ≤ end by snapping the other bound to the edited day.
        if (start != null && end != null && start > end) {
          if (dateInput.dataset.custom === 'start') end = dateInputToMs(dateInput.value, true);
          else start = dateInputToMs(dateInput.value, false);
        }
        if (sessions) { sessionCustomStartMs = start; sessionCustomEndMs = end; }
        else { customStartMs = start; customEndMs = end; }
        saveUiState();
        render(lastData);
      }
    });

    // Persist section collapse state across re-renders. The 'toggle' event does
    // not bubble, so listen in the capture phase.
    root.addEventListener('toggle', e => {
      const t = e.target;
      // Collapsible metric sub-sections inside Breakdown. Persist only — never
      // re-render here: rebuilding the DOM from a toggle handler can re-fire the
      // toggle event on freshly-created open details and spin into a loop.
      if (t && t.matches && t.matches('details[data-subsection]')) {
        breakdownCollapsed[t.dataset.subsection] = !t.open;
        saveUiState();
        return;
      }
      const d = e.target.closest && e.target.closest('details[data-section]');
      if (!d) return;
      if (d.dataset.section === 'budget') budgetOpen = d.open;
      else if (d.dataset.section === 'breakdown') breakdownOpen = d.open;
      else if (d.dataset.section === 'sessions') sessionsOpen = d.open;
      saveUiState();
    }, true);

    root.addEventListener('click', e => {
      if (e.target.closest('[data-breakdown-expand]')) {
        for (const id of BREAKDOWN_SUBSECTIONS) breakdownCollapsed[id] = false;
        saveUiState();
        render(lastData);
        return;
      }
      if (e.target.closest('[data-breakdown-collapse]')) {
        for (const id of BREAKDOWN_SUBSECTIONS) breakdownCollapsed[id] = true;
        saveUiState();
        render(lastData);
        return;
      }

      const th = e.target.closest('[data-sort]');
      if (th) {
        const col = th.dataset.sort;
        if (sessionSort === col) {
          sessionOrder = sessionOrder === 'asc' ? 'desc' : 'asc';
        } else {
          sessionSort = col;
          // Text columns read best A→Z; date/value default to largest-first.
          sessionOrder = (col === 'title' || col === 'source') ? 'asc' : 'desc';
        }
        saveUiState();
        render(lastData);
        return;
      }

      const srow = e.target.closest('.session-row');
      if (srow && srow.dataset.sessionId != null) {
        const id = srow.dataset.sessionId;
        if (expandedSessions.has(id)) expandedSessions.delete(id);
        else expandedSessions.add(id);
        saveUiState();
        render(lastData);
        return;
      }

      const el = e.target.closest('[data-action]');
      if (!el) return;
      vscode.postMessage({ type: el.dataset.action });
    });

    window.addEventListener('message', e => {
      if (e.data.type === 'update') render(e.data);
    });
  </script>
</body>
</html>`;
  }
}
