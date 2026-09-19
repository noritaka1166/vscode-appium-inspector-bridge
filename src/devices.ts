import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface Device { id: string; platform: 'Android' | 'iOS'; udid: string; name: string; state: string }
export interface DeviceReport { devices: Device[]; notes: string[] }
export type DeviceRunner = (command: string, args: string[]) => Promise<string>;

export const runDeviceCommand: DeviceRunner = (command, args) => new Promise((resolve, reject) => {
  const run = (file: string, fallback?: string): void => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback) { run(fallback); return; }
      reject(new Error(error.killed ? `${command}: 確認が15秒でタイムアウトしました。`
        : `${command}: ${String(stderr || error.message).slice(0, 1000)}`));
    });
  };
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  run(command, command === 'adb' && sdk ? join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : undefined);
});

export function parseAndroid(output: string): DeviceReport {
  const devices: Device[] = [], notes: string[] = [];
  if (!output.includes('List of devices attached')) throw new Error('adb の端末一覧形式を読み取れませんでした。');
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized|no permissions)(?:\s|$)(.*)/.exec(line.trim());
    if (!match) continue;
    const [, udid, state, properties] = match;
    if (state !== 'device') {
      notes.push(`${udid}: ${state}。${state === 'unauthorized' ? '端末のUSBデバッグ許可を確認してください。' : state === 'offline' ? '端末の接続・起動状態を確認してください。' : 'USBアクセス権を確認してください。'}`);
      continue;
    }
    const model = /(?:^|\s)model:(\S+)/.exec(properties)?.[1].replace(/_/g, ' ');
    devices.push({ id: `Android:${udid}`, platform: 'Android', udid, name: model || udid, state: udid.startsWith('emulator-') ? 'エミュレーター・接続中' : '端末・接続中' });
  }
  return { devices, notes };
}

export function parseSimulators(output: string): DeviceReport {
  const value = JSON.parse(output);
  if (!value?.devices || typeof value.devices !== 'object' || Array.isArray(value.devices)) throw new Error('simctl の端末一覧形式を読み取れませんでした。');
  const devices: Device[] = [];
  for (const [runtime, entries] of Object.entries(value.devices)) {
    if (!runtime.includes('.iOS-')) continue;
    if (!Array.isArray(entries)) throw new Error('simctl の端末一覧形式を読み取れませんでした。');
    for (const entry of entries) {
      if (entry.isAvailable !== true) continue;
      if (typeof entry.udid !== 'string' || typeof entry.name !== 'string' || typeof entry.state !== 'string') throw new Error('シミュレーターの情報が不正です。');
      devices.push({ id: `iOS:${entry.udid}`, platform: 'iOS', udid: entry.udid, name: entry.name,
        state: `${runtime.split('.iOS-')[1].replace(/-/g, '.')}・${entry.state === 'Booted' ? '起動中' : entry.state === 'Shutdown' ? '停止中' : entry.state}` });
    }
  }
  return { devices, notes: [] };
}

export async function listDevices(run: DeviceRunner = runDeviceCommand, platform = process.platform): Promise<DeviceReport> {
  const android = async (): Promise<DeviceReport> => {
    try { return parseAndroid(await run('adb', ['devices', '-l'])); }
    catch (error) { return { devices: [], notes: [`Android一覧を取得できません。Android SDK Platform-Toolsを導入し、PATHまたはANDROID_HOMEを確認してください。\n${String(error)}`] }; }
  };
  const ios = async (): Promise<DeviceReport> => {
    if (platform !== 'darwin') return { devices: [], notes: ['iOSシミュレーターの一覧はmacOSのみ対応しています。'] };
    try { return parseSimulators(await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])); }
    catch (error) { return { devices: [], notes: [`iOS一覧を取得できません。Xcode・Simulatorランタイムと、xcode-select -p の選択先を確認してください。\n${String(error)}`] }; }
  };
  const reports = await Promise.all([android(), ios()]);
  return { devices: reports.flatMap(r => r.devices), notes: reports.flatMap(r => r.notes) };
}

export function capabilitiesFor(device: Device): string {
  return JSON.stringify({ platformName: device.platform, 'appium:automationName': device.platform === 'Android' ? 'UiAutomator2' : 'XCUITest',
    'appium:udid': device.udid, 'appium:deviceName': device.name }, null, 2);
}
