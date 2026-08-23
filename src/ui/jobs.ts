import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export type UiAction = 'db_setup' | 'pipeline_dry' | 'pipeline' | 'source_discover' | 'doctor' | 'service_install' | 'service_uninstall';

export interface UiJob {
  id: string;
  profileId: string;
  action: UiAction;
  label: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  output: string;
}

/**
 * Labels live here and are rendered from here, so a button and the job it
 * starts cannot drift apart. They did: the dashboard buttons were rewritten in
 * plain language while these kept the old wording, and a reader who pressed
 * "Find articles now" was told that "Run free dry test" was already running --
 * naming something they had never seen.
 */
export const ACTIONS: Record<UiAction, { script: string; label: string; dryRun?: boolean; takes?: string }> = {
  db_setup: { script: 'db:setup', label: 'Set up storage' },
  pipeline_dry: { script: 'pipeline', label: 'Test the setup', dryRun: true, takes: 'a few minutes on the first run — it checks every source' },
  pipeline: { script: 'pipeline', label: 'Find articles', takes: 'several minutes — it reads and ranks each article' },
  source_discover: { script: 'sources:discover', label: 'Find suggested sources', takes: 'a minute or two' },
  // "Why isn't this working" needs an answer that is not "open a terminal".
  doctor: { script: 'doctor', label: 'Check my setup', takes: 'a few seconds' },
  service_install: { script: 'service:install', label: 'Keep Sift running', takes: 'a few seconds' },
  service_uninstall: { script: 'service:uninstall', label: 'Stop keeping Sift running', takes: 'a few seconds' },
};

export function actionLabel(action: UiAction): string {
  return ACTIONS[action].label;
}

/**
 * Raised when a run is already in progress for this reader. It carries the job
 * so the caller can show that run instead of a dead end -- pressing a button
 * and being told "no" with nothing to click is the worst version of this.
 */
export class JobBusyError extends Error {
  constructor(readonly job: UiJob) {
    super(`${job.label} is already running for ${job.profileId}.`);
    this.name = 'JobBusyError';
  }
}

const MAX_OUTPUT = 60_000;

export function redactUiOutput(raw: string, secrets: string[] = []): string {
  let output = raw;
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(secret, '[REDACTED]');
  }
  return output
    .replace(/\b(?:sk|gsk|AIza|xai|sk-ant)-[A-Za-z0-9_.-]{12,}\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

function secretValues(projectRoot: string, profileId: string): string[] {
  const values: string[] = [];
  for (const path of [resolve(projectRoot, '.env'), resolve(projectRoot, 'profiles', profileId, '.env')]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseEnv(readFileSync(path, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) values.push(value);
      }
    } catch {
      // Redaction remains pattern-based if an env file is malformed.
    }
  }
  return values;
}

function append(job: UiJob, chunk: Buffer | string, secrets: string[]): void {
  job.output = redactUiOutput(`${job.output}${String(chunk)}`, secrets).slice(-MAX_OUTPUT);
}

export class UiJobRunner {
  private readonly jobs = new Map<string, UiJob>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly projectRoot: string) {}

  start(profileId: string, action: UiAction): UiJob {
    const existing = [...this.jobs.values()].find((job) => job.profileId === profileId && job.status === 'running');
    if (existing) throw new JobBusyError(existing);
    const definition = ACTIONS[action];
    if (!definition) throw new Error('Unsupported UI action.');

    const job: UiJob = {
      id: randomUUID(),
      profileId,
      action,
      label: definition.label,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: '',
    };
    this.jobs.set(job.id, job);
    const secrets = secretValues(this.projectRoot, profileId);
    const env = { ...process.env };
    if (definition.dryRun) env.SIFT_DRY_RUN = '1';
    const child = spawn('npm', ['run', definition.script, '--', '--profile', profileId], {
      cwd: this.projectRoot,
      env,
      stdio: 'pipe',
    });
    this.processes.set(job.id, child);
    child.stdout.on('data', (chunk) => append(job, chunk, secrets));
    child.stderr.on('data', (chunk) => append(job, chunk, secrets));
    child.on('error', (error) => append(job, `\n${error.message}\n`, secrets));
    child.on('close', (code) => {
      job.exitCode = code ?? 1;
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.finishedAt = new Date().toISOString();
      this.processes.delete(job.id);
    });
    return job;
  }

  get(id: string): UiJob | null {
    return this.jobs.get(id) ?? null;
  }

  latest(profileId: string): UiJob | null {
    return [...this.jobs.values()]
      .filter((job) => job.profileId === profileId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }

  /** Stop one running job. Returns false when it had already finished. */
  stop(id: string): boolean {
    const child = this.processes.get(id);
    if (!child) return false;
    child.kill('SIGTERM');
    return true;
  }

  running(profileId: string): UiJob | null {
    return [...this.jobs.values()].find((job) => job.profileId === profileId && job.status === 'running') ?? null;
  }

  stopAll(): void {
    for (const child of this.processes.values()) child.kill('SIGTERM');
    this.processes.clear();
  }
}
