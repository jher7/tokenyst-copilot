import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function getConfigDir(): string {
  return path.join(os.homedir(), '.tokenyst');
}

export function debugLog(msg: string): void {
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'copilot.log'),
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {
    // best-effort
  }
}
