/**
 * Windows toast notification (best effort, no dependencies): a PowerShell one-liner through the WinRT toast API,
 * shown under Windows PowerShell's app id. Does nothing on other systems; failures are ignored.
 */
import { spawn } from 'node:child_process';

/** PowerShell single-quoted string: the only escape is '' for ' */
const psQuote = (s: string) => `'${s.replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`;
const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** The PowerShell script (exported for tests: text goes in quoted, never as code). */
export function toastScript(title: string, body: string): string {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlText(title)}</text><text>${xmlText(body)}</text></binding></visual></toast>`;
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml(${psQuote(xml)})`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; ');
}

export function showToast(title: string, body: string): void {
  if (process.platform !== 'win32') return;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', toastScript(title, body)], { stdio: 'ignore', windowsHide: true, detached: true });
    p.on('error', () => undefined);
    p.unref();
  } catch {
    /* best effort */
  }
}
