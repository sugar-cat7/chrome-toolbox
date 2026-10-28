import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';

const owned = new WeakSet<ChildProcess>();
const windowsJobs = new WeakMap<
  ChildProcess,
  {
    guardian: ChildProcess;
    guardianClosed: Promise<void>;
    closed: Promise<void>;
    stopped: Promise<void>;
    terminationRequested: boolean;
    requestStop: () => void;
    cleanup?: Promise<void>;
  }
>();
const closed = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => child.once('close', () => resolve()));
const quoteWindows = (value: string): string =>
  `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/\\+$/u, '$&$&')}"`;

export function spawnOwned(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  let child: ChildProcess;
  if (process.platform === 'win32') {
    const script = readFileSync(new URL('./windows-job.ps1', import.meta.url), 'utf8');
    const jobName = `Local\\Starter-${process.pid}-${randomUUID()}`;
    const environment = options.env ?? process.env;
    const launchOptions = {
      ...options,
      detached: false,
      env: {
        ...environment,
        STARTER_PROCESS_SPEC: Buffer.from(
          JSON.stringify({
            role: 'launch',
            jobName,
            commandLine: [command, ...args].map(quoteWindows).join(' '),
          }),
        ).toString('base64'),
      },
    };
    const guardian = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        // A failed synchronous launcher spawn returns no cleanup handle. The
        // guard must not retain the caller's disposable application directory.
        cwd: tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...environment,
          STARTER_PROCESS_SPEC: Buffer.from(
            JSON.stringify({ role: 'guard', jobName, parentPid: process.pid }),
          ).toString('base64'),
        },
      },
    );
    const guardianClosed = closed(guardian);
    let acknowledged = false;
    let requested = false;
    let output = '';
    guardian.stdout?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-1024);
      acknowledged ||= output.split(/\r?\n/u).includes('STOPPED');
    });
    // Guard errors are propagated by its exit/ack contract; never publish its raw stderr.
    guardian.stderr?.resume();
    const stopped = new Promise<void>((resolve, reject) => {
      guardian.once('error', reject);
      guardian.stdin?.on('error', (error) => {
        if (!acknowledged) reject(error);
      });
      void guardianClosed.then(() => {
        if (guardian.exitCode === 0 && acknowledged) resolve();
        else reject(new Error('Owned Windows Job guard failed to confirm termination'));
      }, reject);
    });
    const stopGuard = () => {
      if (requested) return;
      requested = true;
      guardian.stdin?.end('STOP\n');
    };
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        launchOptions,
      );
    } catch (error) {
      stopGuard();
      const deadline = setTimeout(() => {
        if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGKILL');
      }, 10000);
      deadline.unref();
      void guardianClosed.then(
        () => clearTimeout(deadline),
        () => clearTimeout(deadline),
      );
      // No application was created; retain a handler while the guard closes its empty Job.
      void stopped.catch(() =>
        console.error('Owned Windows guard failed after launcher spawn failure'),
      );
      throw error;
    }
    windowsJobs.set(child, {
      guardian,
      guardianClosed,
      closed: closed(child),
      stopped,
      terminationRequested: false,
      requestStop: stopGuard,
    });
    child.once('exit', stopGuard);
    child.once('error', stopGuard);
    // The original rejected promise remains observable by every cleanup caller.
    void stopped.catch(() => {
      stopGuard();
      // A dead guard cannot release the launcher's last Job handle. End that host
      // promptly; stopTree still propagates the original failed guard contract.
      const job = windowsJobs.get(child)!;
      if (!job.terminationRequested && child.exitCode === null && child.signalCode === null) {
        job.terminationRequested = true;
        child.kill('SIGKILL');
      }
    });
  } else child = spawn(command, args, { ...options, detached: true });
  owned.add(child);
  return child;
}

export async function stopTree(child: ChildProcess, graceMs = 3_000): Promise<void> {
  if (!owned.has(child)) throw new Error('Cleanup requires a process started by spawnOwned');
  if (process.platform === 'win32') {
    const job = windowsJobs.get(child);
    if (!job) throw new Error('Missing owned Windows Job termination barrier');
    job.cleanup ??= Promise.resolve().then(async () => {
      let signalFailure: { error: unknown } | undefined;
      if (
        !job.terminationRequested &&
        child.pid &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        job.terminationRequested = true;
        try {
          // A native exit may precede Node's signal flags. The Job guard can
          // terminate independently; only its barrier establishes completion.
          if (!child.kill('SIGKILL')) job.requestStop();
        } catch (error) {
          signalFailure = { error };
          job.requestStop();
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([job.closed, job.guardianClosed, job.stopped]).then((results) => {
            for (const result of results) if (result.status === 'rejected') throw result.reason;
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // A failed deadline cannot leave the guardian holding the owned cwd/Job.
              if (job.guardian.exitCode === null && job.guardian.signalCode === null)
                job.guardian.kill('SIGKILL');
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              reject(new Error('Owned Windows Job cleanup timeout'));
            }, 10000);
          }),
        ]);
        if (signalFailure) throw signalFailure.error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    await job.cleanup;
    return;
  }
  if (!child.pid) return;
  const pid = child.pid;
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      if (process.platform === 'darwin' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        // XNU excludes zombies from every killpg signal, including existence probes.
        // Only a complete, valid process table may establish that this owned group has stopped.
        const table = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
          encoding: 'utf8',
          timeout: 1_000,
        });
        if (table.error || table.status !== 0)
          throw new Error('Unable to inspect the owned Darwin process group', { cause: error });
        const members: string[] = [];
        const rows = table.stdout.split('\n').filter((line) => line.trim());
        if (!rows.length) throw new Error('Invalid Darwin process table', { cause: error });
        for (const row of rows) {
          const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(row);
          if (
            !fields ||
            !Number.isSafeInteger(Number(fields[1])) ||
            !Number.isSafeInteger(Number(fields[2])) ||
            !/^[HIRSTUZ?][+<>AELNSVWXs]*$/u.test(fields[3] ?? '')
          )
            throw new Error('Invalid Darwin process table', { cause: error });
          if (Number(fields[2]) === pid) {
            members.push(row.trim());
            if (!fields[3]?.startsWith('Z')) throw error;
          }
        }
        console.warn(`Stopped Darwin group ${pid}: ${JSON.stringify(members)}`);
        return false;
      }
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const started = performance.now();
  while (signal(0) && performance.now() - started < graceMs) await pause(50);
  if (signal(0)) signal('SIGKILL');
}

export function pnpmCommand(args: string[]): { command: string; args: string[] } {
  const executable = process.env.npm_execpath;
  if (executable?.match(/\.[cm]?js$/u))
    return { command: process.execPath, args: [executable, ...args] };
  return { command: executable ?? (process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'), args };
}

export function runSync(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export async function run(
  command: string,
  args: string[],
  options: SpawnOptions & { timeout?: number; capture?: boolean; terminationGraceMs?: number } = {},
): Promise<string> {
  const { timeout = 10 * 60_000, capture = false, terminationGraceMs, ...spawnOptions } = options;
  return await new Promise<string>((resolve, reject) => {
    const child = spawnOwned(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: process.platform !== 'win32',
      ...spawnOptions,
    });
    let output = '';
    if (capture) {
      const record = (chunk: Buffer, stream: NodeJS.WriteStream) => {
        output = (output + chunk.toString()).slice(-2_000_000);
        stream.write(chunk);
      };
      child.stdout?.on('data', (chunk: Buffer) => record(chunk, process.stdout));
      child.stderr?.on('data', (chunk: Buffer) => record(chunk, process.stderr));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopTree(child, terminationGraceMs).catch(reject);
    }, timeout);
    let cleanup: Promise<void> | undefined;
    child.once('exit', () => {
      clearTimeout(timer);
      cleanup = stopTree(child, terminationGraceMs);
      void cleanup.catch(reject);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      void stopTree(child, terminationGraceMs).then(() => reject(error), reject);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      void (cleanup ?? stopTree(child, terminationGraceMs)).then(() => {
        if (code === 0 && !timedOut) resolve(output);
        else
          reject(
            new Error(
              `${command} ${args.join(' ')}: ${timedOut ? 'timeout' : `exit ${code}, signal ${signal}`}`,
            ),
          );
      }, reject);
    });
  });
}

export async function pnpm(
  args: string[],
  options: SpawnOptions & { timeout?: number; terminationGraceMs?: number } = {},
): Promise<void> {
  const invocation = pnpmCommand(args);
  await run(invocation.command, invocation.args, options);
}
