import { execFile } from 'node:child_process';
import { platform as nodePlatform } from 'node:process';

interface CheckItem {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'skipped';
  detail: string;
  action?: string;
}
export interface EnvironmentReport { items: CheckItem[]; canStart: boolean }
export type AppiumRunner = (args: string[]) => Promise<string>;

const runAppium: AppiumRunner = args => new Promise((resolve, reject) => {
  // Use the inherited environment, exactly as the server launcher does. Filtering
  // writable PATH entries would hide standard nvm/Homebrew Appium installations.
  execFile('appium', args, { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) {
      const code = (error as { code?: string }).code;
      let detail: string;
      if (code === 'ENOENT') detail = 'appium コマンドが見つかりません。';
      else if (error.killed) detail = '確認が15秒でタイムアウトしました。';
      else detail = `コマンドの実行に失敗しました: ${String(stderr || error.message).slice(0, 1500)}`;
      reject(new Error(detail));
    } else resolve(stdout.trim());
  });
});

function installed(output: string): Record<string, { version: string; installed: boolean }> {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('一覧のJSON形式を確認できませんでした。');
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== 'object' || typeof entry.installed !== 'boolean' || typeof entry.version !== 'string') {
      throw new Error('一覧のJSON形式を確認できませんでした。');
    }
  }
  return value as Record<string, { version: string; installed: boolean }>;
}

export async function checkEnvironment(run: AppiumRunner = runAppium, platform = nodePlatform): Promise<EnvironmentReport> {
  let items: CheckItem[] = [];
  if (platform === 'win32') {
    return { canStart: false, items: [{ name: 'Appium CLI', status: 'error', detail: 'Windows の npm .cmd ランチャーからの起動・環境チェックは未対応です。', action: 'ターミナルで appium --use-plugins=inspector を起動し、「起動済みの Inspector を開く」を使用してください。' }] };
  }
  try {
    const version = await run(['--version']);
    const match = /^(\d+)\.\d+\.\d+(?:[-+][\w.+-]+)?$/.exec(version);
    if (!match) throw new Error('Appium のバージョンを読み取れませんでした。');
    if (Number(match[1]) < 3) {
      items.push({ name: 'Appium', status: 'error', detail: `${version}（この拡張は Appium 3 以降が必要です）`, action: '既存テストとの互換性を確認してから npm install -g appium@3 を実行してください。' });
    } else items.push({ name: 'Appium', status: 'ok', detail: version });
  } catch (error) {
    items.push({ name: 'Appium', status: 'error', detail: String(error instanceof Error ? error.message : error), action: 'ターミナルで appium --version を確認してください。未導入なら npm install -g appium@3 を実行し、PATH が通った環境から VS Code を再起動してください。' });
    items = [...items, { name: 'Inspector プラグイン', status: 'skipped', detail: 'Appium CLI を確認できないため未確認です。' }, { name: 'ドライバー', status: 'skipped', detail: 'Appium CLI を確認できないため未確認です。' }];
    return { items, canStart: false };
  }
  const results = await Promise.all((['plugin', 'driver'] as const).map(async (kind): Promise<CheckItem> => {
    const name = kind === 'plugin' ? 'Inspector プラグイン' : 'ドライバー';
    try {
      const entries = installed(await run([kind, 'list', '--installed', '--json']));
      if (kind === 'plugin') {
        return entries.inspector?.installed
          ? { name, status: 'ok', detail: `inspector ${entries.inspector.version}` }
          : { name, status: 'error', detail: '未導入です。', action: '「初回セットアップ」→「公式プラグインをインストール」、または appium plugin install inspector を実行してください。' };
      }
      const drivers = Object.entries(entries).filter(([, entry]) => entry.installed);
      return drivers.length
        ? { name, status: 'ok', detail: drivers.map(([id, entry]) => `${id} ${entry.version}`).join('\n') }
        : { name, status: 'warning', detail: 'ドライバーがありません。Inspector は開けますが、セッション開始には対象ドライバーが必要です。', action: 'Android: appium driver install uiautomator2\niOS（macOS）: appium driver install xcuitest\n対象に合うものをターミナルで導入してください。' };
    } catch (error) {
      return { name, status: 'error', detail: `導入状況を確認できませんでした（未導入とは限りません）。\n${error instanceof Error ? error.message : String(error)}`, action: `ターミナルで appium ${kind} list --installed --json を実行し、PATH・APPIUM_HOME とそのアクセス権を確認してください。` };
    }
  }));
  items = [...items, ...results];
  return { items, canStart: !items.some(item => item.status === 'error') };
}
