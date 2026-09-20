let language = 'ja';

export function setLanguage(value: string | undefined): void {
  language = value?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

function isJapanese(): boolean {
  return language === 'ja';
}

/** Keep runtime strings independent from the VS Code API so command helpers stay testable. */
export function t(japanese: string, english: string): string {
  return isJapanese() ? japanese : english;
}
