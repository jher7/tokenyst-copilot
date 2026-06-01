import * as vscode from 'vscode';
import { loadConfig, getMonthlySummary } from '../core/local-config';
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
    const { monthlyBudgetUsd, monthlySpentUsd, renewalDay, periodStart, periodEnd } = await getMonthlySummary();
    this._view.webview.postMessage({
      type: 'update',
      allocations: cfg.allocations,
      copilotEnabled: cfg.copilot?.enabled ?? false,
      monthlyBudgetUsd,
      monthlySpentUsd,
      renewalDay,
      periodStart,
      periodEnd,
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
    .panel-section > summary::before {
      content: '▸';
      font-size: 9px;
      transition: transform 0.15s ease;
    }
    .panel-section[open] > summary::before { transform: rotate(90deg); }
    /* Inner chart/kpi blocks shouldn't repeat the section border */
    .panel-section .chart-section,
    .panel-section .kpi-row { border-bottom: none; }
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

    /* Daily usage line chart */
    .usage-peak {
      float: right;
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
      grid-template-columns: 72px 1fr 64px;
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
    let breakdownWindow = 0;
    let budgetOpen = true;
    let breakdownOpen = false;
    // Billing-period boundaries (ms), supplied by the extension host. Null until first update.
    let periodStartMs = null;
    let periodEndMs = null;

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const CREDITS_PER_USD = ${CREDITS_PER_USD};
    function fmtCreditsNum(usd) {
      return (usd * CREDITS_PER_USD).toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    function fmtCredits(usd) {
      return fmtCreditsNum(usd) + ' credits';
    }
    function fmtCrds(usd) {
      return fmtCreditsNum(usd) + ' crds';
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

    function compute(allocations, wDays) {
      let cutoff;
      let fixedElapsedDays = null;
      if (wDays === 'month') {
        if (periodStartMs != null) {
          cutoff = periodStartMs;
        } else {
          const monthStart = new Date();
          monthStart.setDate(1);
          monthStart.setHours(0, 0, 0, 0);
          cutoff = monthStart.getTime();
        }
        fixedElapsedDays = Math.max(1, (Date.now() - cutoff) / 86400000);
      } else {
        cutoff = 0;
      }

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

      const allocs = (allocations || []).filter(
        a => a.provider === 'copilot' && Date.parse(a.at) >= cutoff
      );

      if (allocs.length === 0) return { todaySpent, thisWeekSpent, empty: true };

      const totalSpent = allocs.reduce((s, a) => s + a.costUsd, 0);
      const span = spanDays(allocs);
      const days = fixedElapsedDays ?? span;
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

      // Daily series for the line chart: contiguous, zero-filled days from the
      // window start to today.
      const dayKey = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
      let axisStartMs;
      if (wDays === 'month') {
        axisStartMs = periodStartMs != null ? periodStartMs : cutoff;
      } else {
        axisStartMs = Math.min(...allocs.map(a => Date.parse(a.at)));
      }
      const dayMap = {};
      for (const a of allocs) {
        const k = dayKey(Date.parse(a.at));
        dayMap[k] = (dayMap[k] || 0) + a.costUsd;
      }
      const daily = [];
      const cur = new Date(axisStartMs); cur.setHours(0, 0, 0, 0);
      const todayKey = dayKey(Date.now());
      let guard = 0;
      while (cur.getTime() <= todayKey && guard++ < 1000) {
        const k = cur.getTime();
        daily.push({ t: k, value: dayMap[k] || 0 });
        cur.setDate(cur.getDate() + 1);
      }

      return { todaySpent, thisWeekSpent, totalSpent, avgWeekly, avgDaily, avgMonthly, byDayOfWeek, byModel, byRepo, daily };
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

    function renderBars(rows) {
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
            <span class="bar-value">\${esc(fmtCrds(r.value))}</span>
          </div>
        \`;
      }).join('');
    }

    function barColor(pct) {
      if (pct >= 0.9) return 'red';
      if (pct >= 0.7) return 'yellow';
      return 'green';
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
        <div class="chart-section">
          <div class="section-label">Daily usage <span class="usage-peak">peak \${esc(fmtCredits(peak))}</span></div>
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
      periodStartMs = data.periodStart ? Date.parse(data.periodStart) : null;
      periodEndMs = data.periodEnd ? Date.parse(data.periodEnd) : null;

      const renewalSub = renewalDay != null
        ? \`<span class="pace-sub"><span class="edit-label" data-action="setRenewalDate" title="Edit reset date">Resets on the \${ordinal(renewalDay)}</span></span>\`
        : \`<span class="pace-sub"><span class="edit-label" data-action="setRenewalDate">set reset date</span></span>\`;

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
            \${copilotEnabled
              ? \`<button class="tracking-btn" data-action="disableTracking">Disable</button>\`
              : \`<button class="tracking-btn" data-action="enableTracking">Enable</button>\`
            }
            <button class="tracking-btn" data-action="refresh">↻</button>
          </div>
        </div>
      \`;

      const statsBreak = compute(allocations || [], breakdownWindow);
      // Pace always reflects the current month, independent of the section filter.
      const statsMonth = breakdownWindow === 'month' ? statsBreak : compute(allocations || [], 'month');

      function rangeLabel(win) {
        let startMs, endMs;
        if (win === 'month') {
          if (periodStartMs == null) return '';
          startMs = periodStartMs;
          endMs = periodEndMs ?? Date.now();
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

      function filterSelect(which, value) {
        const range = rangeLabel(value);
        return \`
          <div class="section-filter">
            \${range ? \`<span class="filter-range">\${esc(range)}</span>\` : ''}
            <select class="filter-select" data-filter="\${which}">
              <option value="month" \${value === 'month' ? 'selected' : ''}>This period</option>
              <option value="0" \${value === 0 ? 'selected' : ''}>All time</option>
            </select>
          </div>
        \`;
      }

      const fixedKpiHtml = \`
        <div class="kpi-row">
          <div class="kpi">
            <div class="kpi-label">Today</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsMonth.todaySpent))}</div>
            <div class="kpi-sub">credits</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">This week</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsMonth.thisWeekSpent))}</div>
            <div class="kpi-sub">credits (since Monday)</div>
          </div>
        </div>
      \`;

      const breakdownRange = rangeLabel(breakdownWindow);
      const avgKpiHtml = statsBreak.empty ? '' : \`
        <div class="kpi-row kpi-row--top">
          <div class="kpi">
            <div class="kpi-label">Total spent</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsBreak.totalSpent))}</div>
            <div class="kpi-sub">credits</div>
          </div>
          <div class="kpi-filter">
            \${breakdownRange ? \`<span class="filter-range">\${esc(breakdownRange)}</span>\` : ''}
            <select class="filter-select" data-filter="breakdown">
              <option value="month" \${breakdownWindow === 'month' ? 'selected' : ''}>This period</option>
              <option value="0" \${breakdownWindow === 0 ? 'selected' : ''}>All time</option>
            </select>
          </div>
        </div>
        <div class="kpi-row">
          <div class="kpi">
            <div class="kpi-label">Avg daily</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsBreak.avgDaily))}</div>
            <div class="kpi-sub">credits</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Avg weekly</div>
            <div class="kpi-value">\${esc(fmtCreditsNum(statsBreak.avgWeekly))}</div>
            <div class="kpi-sub">credits</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Avg monthly</div>
            <div class="kpi-value">\${breakdownWindow === 'month' ? '-' : esc(fmtCreditsNum(statsBreak.avgMonthly))}</div>
            <div class="kpi-sub">\${breakdownWindow === 'month' ? '&nbsp;' : 'credits'}</div>
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

      const breakdownHtml = statsBreak.empty ? '<div class="section-empty">No data for this period.</div>' : \`
        \${renderUsageChart(statsBreak.daily)}

        <div class="chart-section">
          <div class="section-label">By day of week</div>
          \${renderBars(statsBreak.byDayOfWeek)}
        </div>

        <div class="chart-section">
          <div class="section-label">By model</div>
          \${renderBars(statsBreak.byModel)}
        </div>

        \${statsBreak.byRepo && statsBreak.byRepo.length > 0 ? \`
        <div class="chart-section">
          <div class="section-label">By repo</div>
          \${renderBars(statsBreak.byRepo)}
        </div>
        \` : ''}
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
          \${avgKpiHtml}
          \${breakdownHtml}
        </details>
      \`;

      root.innerHTML = trackingBar + budgetSection + breakdownSection;

      applyBarWidths();
      wireUsageChart(statsBreak.daily);
    }

    function applyBarWidths() {
      root.querySelectorAll('.bar-fill[data-pct], .progress-fill[data-pct]').forEach(el => {
        el.style.width = el.dataset.pct + '%';
      });
    }

    root.addEventListener('change', e => {
      const sel = e.target.closest('.filter-select');
      if (!sel) return;
      breakdownWindow = sel.value === '0' ? 0 : sel.value;
      render(lastData);
    });

    // Persist section collapse state across re-renders. The 'toggle' event does
    // not bubble, so listen in the capture phase.
    root.addEventListener('toggle', e => {
      const d = e.target.closest && e.target.closest('details[data-section]');
      if (!d) return;
      if (d.dataset.section === 'budget') budgetOpen = d.open;
      else if (d.dataset.section === 'breakdown') breakdownOpen = d.open;
    }, true);

    root.addEventListener('click', e => {
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
