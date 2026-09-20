import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { env, platform as nodePlatform } from 'node:process';

export interface Device { id: string; platform: 'Android' | 'iOS'; udid: string; name: string; state: string }
export interface DeviceReport { devices: Device[]; notes: string[] }
export type DeviceRunner = (command: string, args: string[]) => Promise<string>;

const runDeviceCommand: DeviceRunner = (command, args) => new Promise((resolve, reject) => {
  const run = (file: string, fallback?: string): void => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if ((error as { code?: string }).code === 'ENOENT' && fallback) { run(fallback); return; }
      reject(new Error(error.killed ? `${command}: 確認が15秒でタイムアウトしました。`
        : `${command}: ${String(stderr || error.message).slice(0, 1000)}`));
    });
  };
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  let adbPath: string | undefined;
  if (command === 'adb' && sdk) {
    const executable = nodePlatform === 'win32' ? 'adb.exe' : 'adb';
    adbPath = join(sdk, 'platform-tools', executable);
  }
  run(command, adbPath);
});

export function parseAndroid(output: string): DeviceReport {
  const devices: Device[] = [], notes: string[] = [];
  if (!output.includes('List of devices attached')) throw new Error('adb の端末一覧形式を読み取れませんでした。');
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized|no permissions)(?:\s|$)(.*)/.exec(line.trim());
    if (!match) continue;
    const [, udid, state, properties] = match;
    if (state !== 'device') {
      let guidance = 'USBアクセス権を確認してください。';
      if (state === 'unauthorized') guidance = '端末のUSBデバッグ許可を確認してください。';
      else if (state === 'offline') guidance = '端末の接続・起動状態を確認してください。';
      notes.push(`${udid}: ${state}。${guidance}`);
      continue;
    }
    const model = /(?:^|\s)model:(\S+)/.exec(properties)?.[1].replaceAll('_', ' ');
    devices.push({ id: `Android:${udid}`, platform: 'Android', udid, name: model || udid, state: udid.startsWith('emulator-') ? 'エミュレーター・接続中' : '端末・接続中' });
  }
  return { devices, notes };
}

const simulatorFormatError = (): Error => new Error('simctl の端末一覧形式を読み取れませんでした。');

function simulatorRuntimeName(runtime: string): string | undefined {
  return runtime.includes('.iOS-') ? runtime.split('.iOS-')[1].replaceAll('-', '.') : undefined;
}

function simulatorState(state: string): string {
  if (state === 'Booted') return '起動中';
  if (state === 'Shutdown') return '停止中';
  return state;
}

function parseSimulatorEntry(entry: unknown, runtime: string): Device | undefined {
  if (!entry || typeof entry !== 'object' || !('isAvailable' in entry) || entry.isAvailable !== true) return undefined;
  if (!('udid' in entry) || !('name' in entry) || !('state' in entry)
    || typeof entry.udid !== 'string' || typeof entry.name !== 'string' || typeof entry.state !== 'string') {
    throw new Error('シミュレーターの情報が不正です。');
  }
  return { id: `iOS:${entry.udid}`, platform: 'iOS', udid: entry.udid, name: entry.name,
    state: `${runtime}・${simulatorState(entry.state)}` };
}

export function parseSimulators(output: string): DeviceReport {
  const value = JSON.parse(output);
  if (!value?.devices || typeof value.devices !== 'object' || Array.isArray(value.devices)) throw simulatorFormatError();
  const devices: Device[] = [];
  for (const [runtime, entries] of Object.entries(value.devices)) {
    const runtimeName = simulatorRuntimeName(runtime);
    if (!runtimeName) continue;
    if (!Array.isArray(entries)) throw simulatorFormatError();
    for (const entry of entries) {
      const device = parseSimulatorEntry(entry, runtimeName);
      if (device) devices.push(device);
    }
  }
  return { devices, notes: [] };
}

export async function listDevices(run: DeviceRunner = runDeviceCommand, platform = nodePlatform): Promise<DeviceReport> {
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
