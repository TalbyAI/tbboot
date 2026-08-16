export type RunCommandOptions = {
  file: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  ready?: string;
  readyTimeoutMs?: number;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export function runCommand(options: RunCommandOptions): Promise<CommandResult>;
export function parseJsonOutput<T = unknown>(stdout: string): T;
