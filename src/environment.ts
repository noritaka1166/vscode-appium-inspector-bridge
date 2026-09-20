import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { platform as nodePlatform } from 'node:process';
import { t } from './i18n';

interface CheckItem {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'skipped';
  detail: string;
  action?: string;
}
export interface EnvironmentReport { items: CheckItem[]; canStart: boolean }
export type AppiumRunner = (args: string[]) => Promise<string>;

function commandNotFound(): Error & { code: string } {
  const error = new Error('appium command was not found.') as Error & { code: string };
  error.code = 'ENOENT';
  return error;
}

async function trustedExecutable(candidate: string, uid: number | undefined): Promise<string | undefined> {
  let executable: string;
  try { executable = await realpath(candidate); } catch { return undefined; }
  const file = await stat(executable);
  if (!file.isFile() || (file.mode & 0o022) !== 0 || (uid !== undefined && file.uid !== 0 && file.uid !== uid)) return undefined;
  for (let directory = dirname(executable);;) {
    const entry = await stat(directory);
    if (!entry.isDirectory() || (entry.mode & 0o022) !== 0 || (uid !== undefined && entry.uid !== 0 && entry.uid !== uid)) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return executable;
    directory = parent;
  }
}

/** Resolve a verified absolute Appium executable instead of passing a bare command to PATH lookup. */
export async function resolveAppiumExecutable(pathValue = process.env.PATH ?? '', uid = process.getuid?.()): Promise<string> {
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const executable = await trustedExecutable(join(directory, 'appium'), uid);
    if (executable) return executable;
  }
  throw commandNotFound();
}

const runAppium: AppiumRunner = async args => {
  const executable = await resolveAppiumExecutable();
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as { code?: string }).code;
        let detail: string;
        if (code === 'ENOENT') detail = t('appium コマンドが見つかりません。', 'appium command was not found.');
        else if (error.killed) detail = t('確認が15秒でタイムアウトしました。', 'Check timed out after 15 seconds.');
        else detail = t(`コマンドの実行に失敗しました: ${String(stderr || error.message).slice(0, 1500)}`, `Command failed: ${String(stderr || error.message).slice(0, 1500)}`);
        reject(new Error(detail));
      } else resolve(stdout.trim());
    });
  });
};

function installed(output: string): Record<string, { version: string; installed: boolean }> {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('一覧のJSON形式を確認できませんでした。', 'Could not parse the list JSON.'));
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== 'object' || typeof entry.installed !== 'boolean' || typeof entry.version !== 'string') {
      throw new Error(t('一覧のJSON形式を確認できませんでした。', 'Could not parse the list JSON.'));
    }
  }
  return value as Record<string, { version: string; installed: boolean }>;
}

export async function checkEnvironment(run: AppiumRunner = runAppium, platform = nodePlatform): Promise<EnvironmentReport> {
  let items: CheckItem[] = [];
  if (platform === 'win32') {
    return { canStart: false, items: [{ name: 'Appium CLI', status: 'error', detail: t('Windows の npm .cmd ランチャーからの起動・環境チェックは未対応です。', 'Starting and checking npm .cmd launchers on Windows is not supported.'), action: t('ターミナルで appium --use-plugins=inspector を起動し、「起動済みの Inspector を開く」を使用してください。', 'Start `appium --use-plugins=inspector` in a terminal, then use “Open Running Inspector”.') }] };
  }
  try {
    const version = await run(['--version']);
    const match = /^(\d+)\.\d+\.\d+(?:[-+][\w.+-]+)?$/.exec(version);
    if (!match) throw new Error(t('Appium のバージョンを読み取れませんでした。', 'Could not read the Appium version.'));
    if (Number(match[1]) < 3) {
      items.push({ name: 'Appium', status: 'error', detail: t(`${version}（この拡張は Appium 3 以降が必要です）`, `${version} (this extension requires Appium 3 or later)`), action: t('既存テストとの互換性を確認してから npm install -g appium@3 を実行してください。', 'Check compatibility with existing tests, then run `npm install -g appium@3`.') });
    } else items.push({ name: 'Appium', status: 'ok', detail: version });
  } catch (error) {
    items.push({ name: 'Appium', status: 'error', detail: String(error instanceof Error ? error.message : error), action: t('ターミナルで appium --version を確認してください。未導入なら npm install -g appium@3 を実行し、PATH が通った環境から VS Code を再起動してください。', 'Run `appium --version` in a terminal. If it is not installed, run `npm install -g appium@3`, then restart VS Code from an environment with Appium on PATH.') });
    items = [...items, { name: t('Inspector プラグイン', 'Inspector plugin'), status: 'skipped', detail: t('Appium CLI を確認できないため未確認です。', 'Not checked because the Appium CLI could not be verified.') }, { name: t('ドライバー', 'Drivers'), status: 'skipped', detail: t('Appium CLI を確認できないため未確認です。', 'Not checked because the Appium CLI could not be verified.') }];
    return { items, canStart: false };
  }
  const results = await Promise.all((['plugin', 'driver'] as const).map(async (kind): Promise<CheckItem> => {
    const name = kind === 'plugin' ? t('Inspector プラグイン', 'Inspector plugin') : t('ドライバー', 'Drivers');
    try {
      const entries = installed(await run([kind, 'list', '--installed', '--json']));
      if (kind === 'plugin') {
        return entries.inspector?.installed
          ? { name, status: 'ok', detail: `inspector ${entries.inspector.version}` }
          : { name, status: 'error', detail: t('未導入です。', 'Not installed.'), action: t('「初回セットアップ」→「公式プラグインをインストール」、または appium plugin install inspector を実行してください。', 'Select “Install Official Plugin” in Initial Setup, or run `appium plugin install inspector`.') };
      }
      const drivers = Object.entries(entries).filter(([, entry]) => entry.installed);
      return drivers.length
        ? { name, status: 'ok', detail: drivers.map(([id, entry]) => `${id} ${entry.version}`).join('\n') }
        : { name, status: 'warning', detail: t('ドライバーがありません。Inspector は開けますが、セッション開始には対象ドライバーが必要です。', 'No drivers are installed. Inspector can open, but starting a session requires a driver.'), action: t('Android: appium driver install uiautomator2\niOS（macOS）: appium driver install xcuitest\n対象に合うものをターミナルで導入してください。', 'Android: appium driver install uiautomator2\niOS (macOS): appium driver install xcuitest\nInstall the driver that matches your target in a terminal.') };
    } catch (error) {
      return { name, status: 'error', detail: t(`導入状況を確認できませんでした（未導入とは限りません）。\n${error instanceof Error ? error.message : String(error)}`, `Could not check installation status (it may still be installed).\n${error instanceof Error ? error.message : String(error)}`), action: t(`ターミナルで appium ${kind} list --installed --json を実行し、PATH・APPIUM_HOME とそのアクセス権を確認してください。`, `Run appium ${kind} list --installed --json in a terminal, then check PATH, APPIUM_HOME, and access permissions.`) };
    }
  }));
  items = [...items, ...results];
  return { items, canStart: !items.some(item => item.status === 'error') };
}
