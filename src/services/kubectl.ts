import { spawn } from 'node:child_process';
import { redactSecrets } from '../utils/validation.js';

export interface KubectlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunKubectlOptions {
  timeoutMs?: number;
  stdin?: string;
  redact?: string[];
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export type KubectlErrorCode =
  | 'NOT_INSTALLED'
  | 'TIMEOUT'
  | 'EXECUTION_ERROR'
  | 'PARSE_ERROR';

export class KubectlError extends Error {
  readonly code: KubectlErrorCode;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly args: string[];

  constructor(params: {
    message: string;
    code: KubectlErrorCode;
    stderr?: string;
    exitCode?: number | null;
    args: string[];
  }) {
    super(params.message);
    this.name = 'KubectlError';
    this.code = params.code;
    this.stderr = params.stderr ?? '';
    this.exitCode = params.exitCode ?? null;
    this.args = params.args;
  }
}

export type KubectlExecutor = (
  args: string[],
  options?: RunKubectlOptions,
) => Promise<KubectlResult>;

export function spawnKubectl(
  args: string[],
  options?: RunKubectlOptions,
  binary = 'kubectl',
): Promise<KubectlResult> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const secretsToRedact = options?.redact ?? [];

  return new Promise<KubectlResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: [options?.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1_500);
      } catch {
        // ignore
      }
      reject(
        new KubectlError({
          code: 'TIMEOUT',
          message: redactSecrets(
            `Tiempo agotado (${timeoutMs}ms) ejecutando kubectl ${args.join(' ')}`,
            secretsToRedact,
          ),
          stderr: redactSecrets(stderr, secretsToRedact),
          exitCode: null,
          args,
        }),
      );
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options?.onStdout?.(redactSecrets(text, secretsToRedact));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options?.onStderr?.(redactSecrets(text, secretsToRedact));
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new KubectlError({
            code: 'NOT_INSTALLED',
            message: 'No se encontró el binario "kubectl" en el PATH del sistema.',
            stderr: redactSecrets(err.message, secretsToRedact),
            exitCode: null,
            args,
          }),
        );
        return;
      }
      reject(
        new KubectlError({
          code: 'EXECUTION_ERROR',
          message: redactSecrets(
            `Error al invocar kubectl: ${err.message}`,
            secretsToRedact,
          ),
          stderr: redactSecrets(err.message, secretsToRedact),
          exitCode: null,
          args,
        }),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const exitCode = code ?? 1;
      const safeStdout = redactSecrets(stdout, secretsToRedact);
      const safeStderr = redactSecrets(stderr, secretsToRedact);

      if (exitCode !== 0) {
        const cleanErr =
          safeStderr.trim() || safeStdout.trim() || `Código de salida ${exitCode}`;
        reject(
          new KubectlError({
            code: 'EXECUTION_ERROR',
            message: cleanErr,
            stderr: safeStderr.trim(),
            exitCode,
            args,
          }),
        );
        return;
      }

      resolve({
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode,
      });
    });

    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // Handled by process close/error events
      });
      child.stdin.write(options.stdin, 'utf8');
      child.stdin.end();
    }
  });
}

let activeExecutor: KubectlExecutor = (args, options) => spawnKubectl(args, options);

export function setKubectlExecutorForTesting(executor: KubectlExecutor | null): void {
  activeExecutor = executor ?? ((args, options) => spawnKubectl(args, options));
}

export function runKubectl(
  args: string[],
  options?: RunKubectlOptions,
): Promise<KubectlResult> {
  return activeExecutor(args, options);
}

export async function runKubectlJson<T>(
  args: string[],
  options?: RunKubectlOptions,
): Promise<T> {
  const result = await runKubectl(args, options);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new KubectlError({
      code: 'PARSE_ERROR',
      message: `No se pudo interpretar la salida JSON de kubectl: ${
        err instanceof Error ? err.message : String(err)
      }`,
      stderr: result.stderr,
      exitCode: result.exitCode,
      args,
    });
  }
}
