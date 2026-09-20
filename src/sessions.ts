import { serverKey } from './connection';
import { t } from './i18n';

export interface RunningSession {
  id: string;
  created?: number;
  platformName?: string;
  deviceName?: string;
  automationName?: string;
}

export interface SessionReport {
  serverUrl: string;
  sessions: RunningSession[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
};

export class SessionDiscoveryError extends Error {}

export async function listRunningSessions(
  rawServerUrl: string,
  request: typeof fetch = fetch,
): Promise<SessionReport> {
  const serverUrl = serverKey(rawServerUrl);
  let response: Response;
  try {
    response = await request(`${serverUrl}/appium/sessions`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new Error(
      t(
        'Appium Server の起動中セッションを取得できません。Server URL と接続状態を確認してください。',
        'Could not retrieve running Appium sessions. Check the Server URL and connection.',
      ),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new SessionDiscoveryError(
      t(
        '起動中セッションの一覧には Appium の session_discovery が必要です。外部起動の Server は `--allow-insecure=*:session_discovery` を付けて再起動してください。',
        'Listing sessions requires Appium session_discovery. Restart an externally started server with `--allow-insecure=*:session_discovery`.',
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      t(
        `起動中セッションを取得できませんでした（HTTP ${response.status}）。`,
        `Could not retrieve running sessions (HTTP ${response.status}).`,
      ),
    );
  }
  const body = asRecord(await response.json());
  const values = Array.isArray(body?.value) ? body.value : undefined;
  if (!values) {
    throw new Error(
      t(
        'Appium Server から予期しないセッション一覧が返されました。',
        'Appium Server returned an unexpected session list.',
      ),
    );
  }
  const sessions = values.flatMap((value): RunningSession[] => {
    const item = asRecord(value);
    if (!item || typeof item.id !== 'string' || !item.id.trim()) return [];
    const capabilities = asRecord(item.capabilities) ?? {};
    const platformName = stringValue(capabilities, 'platformName', 'platform');
    const deviceName = stringValue(
      capabilities,
      'appium:deviceName',
      'deviceName',
    );
    const automationName = stringValue(
      capabilities,
      'appium:automationName',
      'automationName',
    );
    return [
      {
        id: item.id,
        ...(typeof item.created === 'number' ? { created: item.created } : {}),
        ...(platformName ? { platformName } : {}),
        ...(deviceName ? { deviceName } : {}),
        ...(automationName ? { automationName } : {}),
      },
    ];
  });
  return {
    serverUrl,
    sessions: sessions.sort((a, b) => (b.created ?? 0) - (a.created ?? 0)),
  };
}
