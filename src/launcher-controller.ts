import type { LauncherMessage } from './webview-protocol';

type Post = (message: unknown) => void;
type Output = { appendLine(data: string): void };

export class LauncherController {
  private readonly activeOperations = new Map<string, string | undefined>();

  constructor(
    private readonly post: Post,
    private readonly output: Output,
    private readonly passive: (message: LauncherMessage) => boolean,
    private readonly dispatch: (message: LauncherMessage) => Promise<void>,
    private readonly loadingLabel: (
      message: LauncherMessage,
    ) => string | undefined,
  ) {}

  get isBusy(): boolean {
    return this.activeOperations.size > 0;
  }

  async handle(message: LauncherMessage): Promise<void> {
    if (this.passive(message)) return;
    const operation = this.operationKey(message);
    if (this.activeOperations.has(operation)) return;
    const label = this.loadingLabel(message);
    this.activeOperations.set(operation, label);
    if (label) this.post({ type: 'loading', active: true, label });
    try {
      await this.dispatch(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(text);
      this.post({ type: 'notice', level: 'error', text });
    } finally {
      this.activeOperations.delete(operation);
      if (label) {
        const remainingLabel = [...this.activeOperations.values()].find(
          Boolean,
        );
        this.post(
          remainingLabel
            ? { type: 'loading', active: true, label: remainingLabel }
            : { type: 'loading', active: false },
        );
      }
    }
  }

  private operationKey(message: LauncherMessage): string {
    switch (message.type) {
      case 'deviceCapabilities':
      case 'copyCapabilities':
        return `${message.type}:${message.deviceId}`;
      case 'attachSession':
        return `${message.type}:${message.serverUrl}:${message.sessionId}`;
      case 'listSessions':
      case 'startOfficial':
      case 'openOfficial':
      case 'reconnect':
        return `${message.type}:${message.serverUrl}`;
      default:
        return message.type;
    }
  }
}
