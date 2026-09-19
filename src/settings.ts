export const settingKeys = ['PREFERRED_LANGUAGE', 'PREFERRED_THEME', 'SAVED_SESSIONS', 'SET_SAVED_GESTURES', 'SERVER_ARGS', 'SESSION_SERVER_PARAMS', 'SESSION_SERVER_TYPE', 'SAVED_FRAMEWORK', 'VISIBLE_PROVIDERS'];

export function validateSettings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Inspector settings');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!settingKeys.includes(key) || typeof entry !== 'string') throw new Error('Invalid Inspector setting');
    JSON.parse(entry);
    result[key] = entry;
  }
  if (JSON.stringify(result).length > 5_000_000) throw new Error('Inspector settings exceed 5 MB');
  return result;
}
