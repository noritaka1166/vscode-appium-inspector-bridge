/**
 * Messages accepted from the launcher webview.
 *
 * Webview messages are untrusted runtime values. Keep the parser here rather
 * than relying on TypeScript casts at the VS Code extension boundary.
 */
export const launcherMessageTypes = [
  'deviceCapabilities',
  'copyCapabilities',
  'listDevices',
  'listSessions',
  'attachSession',
  'startOfficial',
  'openOfficial',
  'watchServer',
  'reconnect',
  'installOfficial',
  'installAppium',
  'showDriverGuide',
  'checkEnvironment',
  'ready',
  'stopServer',
  'showOutput',
] as const;

type LauncherMessageType = (typeof launcherMessageTypes)[number];
type ServerMessageType = Extract<
  LauncherMessageType,
  | 'startOfficial'
  | 'openOfficial'
  | 'watchServer'
  | 'reconnect'
  | 'listSessions'
>;
type DeviceMessageType = Extract<
  LauncherMessageType,
  'deviceCapabilities' | 'copyCapabilities'
>;
type AttachMessageType = Extract<LauncherMessageType, 'attachSession'>;

export type LauncherMessage =
  | { type: DeviceMessageType; deviceId: string }
  | { type: AttachMessageType; serverUrl: string; sessionId: string }
  | { type: ServerMessageType; serverUrl: string }
  | {
      type: Exclude<
        LauncherMessageType,
        DeviceMessageType | ServerMessageType | AttachMessageType
      >;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (
  value: Record<string, unknown>,
  key: 'deviceId' | 'serverUrl' | 'sessionId',
): string | undefined => {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate
    : undefined;
};

/** Returns undefined for malformed or unsupported messages. */
export function parseLauncherMessage(
  value: unknown,
): LauncherMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  switch (value.type) {
    case 'deviceCapabilities':
    case 'copyCapabilities': {
      const deviceId = nonEmptyString(value, 'deviceId');
      return deviceId ? { type: value.type, deviceId } : undefined;
    }
    case 'startOfficial':
    case 'openOfficial':
    case 'watchServer':
    case 'reconnect': {
      const serverUrl = nonEmptyString(value, 'serverUrl');
      return serverUrl ? { type: value.type, serverUrl } : undefined;
    }
    case 'attachSession': {
      const serverUrl = nonEmptyString(value, 'serverUrl');
      const sessionId = nonEmptyString(value, 'sessionId');
      return serverUrl && sessionId
        ? { type: value.type, serverUrl, sessionId }
        : undefined;
    }
    case 'installOfficial':
    case 'installAppium':
    case 'showDriverGuide':
    case 'checkEnvironment':
    case 'listDevices':
    case 'ready':
    case 'stopServer':
    case 'showOutput':
      return { type: value.type };
    default:
      return undefined;
  }
}
