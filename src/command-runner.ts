import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { commandInvocation } from './environment';

type Output = { append(data: string): void };

export interface LoggedCommandOptions {
  output: Output;
  failure: string;
  cwd?: string;
  startFailure?: (error: Error) => Error;
  spawnProcess?: typeof spawn;
}

/** Runs a trusted command, forwarding both streams to the extension output channel. */
export async function runLoggedCommand(
  command: string,
  args: string[],
  {
    output,
    failure,
    cwd,
    startFailure,
    spawnProcess = spawn,
  }: LoggedCommandOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      const invocation = commandInvocation(command, args);
      child = spawnProcess(invocation.command, invocation.args, {
        shell: false,
        cwd,
      });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      reject(startFailure ? startFailure(reason) : reason);
      return;
    }
    child.stdout.on('data', (data) => output.append(data.toString()));
    child.stderr.on('data', (data) => output.append(data.toString()));
    child.once('error', (error) =>
      reject(startFailure ? startFailure(error) : error),
    );
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(failure)),
    );
  });
}
