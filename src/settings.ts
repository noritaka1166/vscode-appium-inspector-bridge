import type * as vscode from 'vscode';

export const settingKeys = [
  'PREFERRED_LANGUAGE',
  'PREFERRED_THEME',
  'SAVED_SESSIONS',
  'SET_SAVED_GESTURES',
  'SERVER_ARGS',
  'SESSION_SERVER_PARAMS',
  'SESSION_SERVER_TYPE',
  'SAVED_FRAMEWORK',
  'VISIBLE_PROVIDERS',
];

export function validateSettings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Inspector settings');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!settingKeys.includes(key) || typeof entry !== 'string')
      throw new Error('Invalid Inspector setting');
    JSON.parse(entry);
    result[key] = entry;
  }
  if (JSON.stringify(result).length > 5_000_000)
    throw new Error('Inspector settings exceed 5 MB');
  return result;
}

export interface LoadedSettings {
  values: Record<string, string>;
  recovered: boolean;
}

/** Serializes SecretStorage writes and recovers safely from stale saved values. */
export class InspectorSettingsStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(key: string): Promise<LoadedSettings> {
    await this.writes;
    const saved = await this.secrets.get(key);
    if (!saved) return { values: {}, recovered: false };
    try {
      return { values: validateSettings(JSON.parse(saved)), recovered: false };
    } catch {
      return { values: {}, recovered: true };
    }
  }

  async save(key: string, values: unknown): Promise<Record<string, string>> {
    const validated = validateSettings(values);
    const snapshot = JSON.stringify(validated);
    const write = this.writes.then(() => this.secrets.store(key, snapshot));
    this.writes = write.catch(() => undefined);
    await write;
    return validated;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}

/** Adds the endpoint used by Inspector's Attach to Session flow without trusting stale JSON. */
export function withAttachServer(
  values: Record<string, string>,
  serverUrl: string,
): Record<string, string> {
  let previous: Record<string, unknown> = {};
  try {
    if (values.SESSION_SERVER_PARAMS) {
      const parsed: unknown = JSON.parse(values.SESSION_SERVER_PARAMS);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        previous = parsed as Record<string, unknown>;
    }
  } catch {
    // The surrounding settings are valid, but this individual Inspector value is stale.
  }
  const existingRemote = previous.remote;
  const remote =
    existingRemote &&
    typeof existingRemote === 'object' &&
    !Array.isArray(existingRemote)
      ? (existingRemote as Record<string, unknown>)
      : {};
  const server = new URL(serverUrl);
  return {
    ...values,
    SESSION_SERVER_PARAMS: JSON.stringify({
      ...previous,
      remote: {
        ...remote,
        hostname: server.hostname,
        port: server.port || '80',
        path: server.pathname || '/',
      },
    }),
    SESSION_SERVER_TYPE: JSON.stringify('remote'),
  };
}
