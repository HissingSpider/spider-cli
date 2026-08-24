import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

/**
 * A persistent shell, and background jobs.
 *
 * Every `bash` call used to be a fresh `exec`, so `cd src` did nothing to the
 * next call and an exported variable evaporated. That is a surprising and
 * expensive difference from how a person uses a terminal: the model runs `cd`,
 * sees success, and then every relative path it uses afterwards is wrong.
 *
 * One long-lived shell fixes that. Completion is detected with a sentinel
 * carrying the exit status, because a shell gives no other in-band signal that
 * a command has finished.
 */

/**
 * Which shell to spawn. zsh is the macOS default and was hardcoded here, which
 * meant every command failed with ENOENT on a machine without it — most Linux
 * boxes, containers, and CI runners. Resolved once at load: an explicit
 * override, then the user's login shell, then the usual suspects.
 *
 * `-f` (skip startup files) is only passed to shells that understand it; sh
 * does not, and would treat it as an option error.
 */
function resolveShell(): { path: string; args: string[] } {
  const candidates = [
    process.env.SPIDER_SHELL,
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      const name = candidate.split('/').pop() ?? '';
      // zsh -f and bash --noprofile --norc both skip user startup files, which
      // keeps a stray alias or prompt hook out of the agent's command output.
      const args = name === 'zsh' ? ['-f'] : name === 'bash' ? ['--noprofile', '--norc'] : [];
      return { path: candidate, args };
    } catch {
      /* not executable or not present; try the next */
    }
  }
  return { path: '/bin/sh', args: [] };
}

export const SHELL = resolveShell();

const SENTINEL = '__SPIDER_DONE__';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE = 10 * 1024 * 1024;

export type ShellResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
};

class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private busy = false;

  constructor(private readonly cwd: string) {}

  private start(): ChildProcessWithoutNullStreams {
    const proc = spawn(SHELL.path, SHELL.args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    // A dead shell is replaced on the next call rather than poisoning it.
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.proc;
    return this.start();
  }

  /** Drop the shell, so the next command starts from a known state. */
  reset(): void {
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }

  async run(
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onData?: (chunk: string) => void,
  ): Promise<ShellResult> {
    // The shell is a single resource; overlapping writes would interleave two
    // commands into one stream.
    if (this.busy) {
      return {
        stdout: '',
        stderr: 'The shell is busy with another command.',
        code: 1,
        timedOut: false,
      };
    }
    this.busy = true;

    const proc = this.ensure();
    const marker = SENTINEL + randomUUID().replace(/-/g, '');

    return new Promise<ShellResult>((resolve) => {
      let out = '';
      let err = '';
      let done = false;

      const finish = (result: ShellResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        proc.stdout.off('data', onOut);
        proc.stderr.off('data', onErr);
        proc.off('exit', onExit);
        this.busy = false;
        resolve(result);
      };

      /**
       * The command killed the shell — `exit`, or something fatal. The sentinel
       * is never coming, so waiting for it would hang until the timeout. The
       * shell's own exit status is the command's, which is what the caller
       * wanted anyway.
       */
      const onExit = (code: number | null) => {
        this.proc = null;
        finish({
          stdout: out.replace(/\n$/, ''),
          stderr: (err + '\n[the shell exited; a new one starts on the next command]').trim(),
          code: code ?? 0,
          timedOut: false,
        });
      };

      const timer = setTimeout(() => {
        // The command owns the shell's stdin; there is no way to interrupt just
        // it, so the shell goes and the next call gets a fresh one.
        this.reset();
        finish({
          stdout: out,
          stderr: err + '\nCommand timed out after ' + timeoutMs + 'ms; the shell was restarted.',
          code: 124,
          timedOut: true,
        });
      }, timeoutMs);

      const onOut = (chunk: string) => {
        const at = chunk.indexOf(marker);
        if (at === -1) {
          out += chunk;
          if (out.length > MAX_CAPTURE) out = out.slice(0, MAX_CAPTURE);
          onData?.(chunk);
          return;
        }
        out += chunk.slice(0, at);
        onData?.(chunk.slice(0, at));
        const tail = chunk.slice(at + marker.length);
        const code = Number.parseInt(tail.trim(), 10);
        finish({
          stdout: out.replace(/\n$/, ''),
          stderr: err.replace(/\n$/, ''),
          code: Number.isFinite(code) ? code : 0,
          timedOut: false,
        });
      };

      const onErr = (chunk: string) => {
        err += chunk;
        if (err.length > MAX_CAPTURE) err = err.slice(0, MAX_CAPTURE);
        onData?.(chunk);
      };

      proc.stdout.on('data', onOut);
      proc.stderr.on('data', onErr);
      proc.on('exit', onExit);
      // `printf` rather than `echo` so the exit status is not mangled by flags.
      proc.stdin.write(command + '\nprintf "' + marker + '%d\\n" $?\n');
    });
  }

  /** Where the shell currently is — `cd` persists, so this can drift. */
  async pwd(): Promise<string> {
    const r = await this.run('pwd', 5_000);
    return r.stdout.trim() || this.cwd;
  }
}

const shells = new Map<string, PersistentShell>();

export function shellFor(cwd: string): PersistentShell {
  let shell = shells.get(cwd);
  if (!shell) {
    shell = new PersistentShell(cwd);
    shells.set(cwd, shell);
  }
  return shell;
}

export function resetShells(): void {
  for (const s of shells.values()) s.reset();
  shells.clear();
}

/* ---------------------------------------------------------------- background */

/** A background job needs no stdin, so its streams are typed accordingly. */
type BackgroundProcess = ChildProcess & { stdout: Readable; stderr: Readable };

export type BackgroundJob = {
  id: string;
  command: string;
  proc: BackgroundProcess;
  output: string;
  /** How much of `output` has already been handed to the model. */
  read: number;
  exitCode: number | null;
  startedAt: number;
};

const jobs = new Map<string, BackgroundJob>();
let nextJobId = 1;

/**
 * Start a command without waiting for it. A dev server or a long test run
 * blocks the whole agent otherwise, and killing it at the 120s timeout is not
 * the same as letting it run.
 */
export function startBackground(command: string, cwd: string): BackgroundJob {
  const proc = spawn(SHELL.path, [...SHELL.args, '-c', command], {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as BackgroundProcess;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  const job: BackgroundJob = {
    id: 'bg_' + nextJobId++,
    command,
    proc,
    output: '',
    read: 0,
    exitCode: null,
    startedAt: Date.now(),
  };

  const append = (chunk: string) => {
    job.output += chunk;
    // Unbounded growth from a chatty server would eat the process.
    if (job.output.length > MAX_CAPTURE) {
      job.output = job.output.slice(-MAX_CAPTURE);
      job.read = Math.min(job.read, job.output.length);
    }
  };
  proc.stdout.on('data', append);
  proc.stderr.on('data', append);
  proc.on('exit', (code) => {
    job.exitCode = code ?? 0;
  });

  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id);
}

export function listJobs(): BackgroundJob[] {
  return [...jobs.values()];
}

/** Output since the last read — polling should not re-deliver what was seen. */
export function readJob(
  id: string,
): { text: string; running: boolean; exitCode: number | null } | null {
  const job = jobs.get(id);
  if (!job) return null;
  const text = job.output.slice(job.read);
  job.read = job.output.length;
  return { text, running: job.exitCode === null, exitCode: job.exitCode };
}

export function killJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.exitCode === null) job.proc.kill('SIGTERM');
  return true;
}

export function killAllJobs(): void {
  for (const job of jobs.values()) {
    if (job.exitCode === null) job.proc.kill('SIGTERM');
  }
  jobs.clear();
}
