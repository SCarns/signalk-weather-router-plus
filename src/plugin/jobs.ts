/**
 * Job manager: queue of route requests, one running at a time in the
 * worker, with an event log per job for Server-Sent Events (resumable
 * via Last-Event-ID) and on-disk persistence of finished jobs.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobProgress, JobStatus, RouteRequest, RouteSummary } from './protocol';

export interface JobEvent {
  id: number;
  event: 'status' | 'progress' | 'route' | 'done' | 'error';
  data: Record<string, unknown>;
}

export interface Job {
  id: string;
  status: JobStatus;
  request: RouteRequest;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress[];
  summary?: RouteSummary;
  error?: string;
  geojson?: Record<string, unknown>;
  skRoute?: Record<string, unknown>;
  skeleton?: Record<string, unknown> | null;
  /** Resources API id when published. */
  resourceId?: string;
  publishError?: string;
  events: JobEvent[];
  nextEventId: number;
}

export interface JobPublic {
  id: string;
  status: JobStatus;
  request: RouteRequest;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  progress: JobProgress[];
  summary?: RouteSummary;
  error?: string;
  resource_id?: string;
  publish_error?: string;
  links: Record<string, string>;
}

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running: string | null = null;
  private readonly dir: string;

  constructor(
    dataDir: string,
    private keepJobs: number,
    private readonly basePath: string
  ) {
    super();
    this.dir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadPersisted();
  }

  private loadPersisted(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Job;
        if (j.status === 'running' || j.status === 'queued') {
          j.status = 'failed';
          j.error = 'plugin restarted while the job was in progress';
        }
        j.events = j.events ?? [];
        j.nextEventId = j.nextEventId ?? j.events.length + 1;
        this.jobs.set(j.id, j);
      } catch {
        // ignore corrupt file
      }
    }
    this.trim();
  }

  private persist(job: Job): void {
    if (job.status === 'queued' || job.status === 'running') return;
    const tmp = path.join(this.dir, `${job.id}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, path.join(this.dir, `${job.id}.json`));
  }

  /** Change how many finished jobs are kept (settings) and trim now. */
  setKeepJobs(n: number): void {
    this.keepJobs = n;
    this.trim();
  }

  private trim(): void {
    const finished = [...this.jobs.values()]
      .filter(j => j.status !== 'queued' && j.status !== 'running')
      .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
    for (const j of finished.slice(this.keepJobs)) this.delete(j.id);
  }

  private emitEvent(job: Job, event: JobEvent['event'], data: Record<string, unknown>): void {
    const ev: JobEvent = { id: job.nextEventId++, event, data };
    job.events.push(ev);
    if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    this.emit('event', job.id, ev);
  }

  links(id: string): Record<string, string> {
    const b = `${this.basePath}/api/routes/${id}`;
    return {
      self: b,
      events: `${b}/events`,
      result: `${b}/result`,
      skeleton: `${b}/skeleton`,
      cancel: `${b}/cancel`,
      publish: `${b}/publish`,
    };
  }

  toPublic(job: Job): JobPublic {
    return {
      id: job.id,
      status: job.status,
      request: job.request,
      created_at: job.createdAt,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      progress: job.progress.slice(-20),
      summary: job.summary,
      error: job.error,
      resource_id: job.resourceId,
      publish_error: job.publishError,
      links: this.links(job.id),
    };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(limit = 50): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get runningId(): string | null {
    return this.running;
  }

  submit(request: RouteRequest): Job {
    const job: Job = {
      id: randomUUID(),
      status: 'queued',
      request,
      createdAt: new Date().toISOString(),
      progress: [],
      events: [],
      nextEventId: 1,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.emitEvent(job, 'status', { status: 'queued', position: this.queue.length });
    this.pump();
    return job;
  }

  /** Called by the plugin to start the next queued job in the worker. */
  private pump(): void {
    if (this.running || this.queue.length === 0) return;
    const id = this.queue.shift()!;
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') {
      this.pump();
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.running = id;
    this.emitEvent(job, 'status', { status: 'running' });
    this.emit('start', job);
  }

  onProgress(id: string, stage: number, total: number, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const p: JobProgress = { time: new Date().toISOString(), stage, total, message };
    job.progress.push(p);
    if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
    this.emitEvent(job, 'progress', p as unknown as Record<string, unknown>);
  }

  onDone(
    id: string,
    geojson: Record<string, unknown>,
    skRoute: Record<string, unknown>,
    summary: RouteSummary,
    skeleton: Record<string, unknown> | null = null
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.geojson = geojson;
    job.skRoute = skRoute;
    job.skeleton = skeleton;
    job.summary = summary;
    this.emitEvent(job, 'route', geojson);
    this.emitEvent(job, 'done', { status: 'done', summary });
    this.finish(job);
  }

  onError(id: string, message: string, cancelled = false): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = cancelled ? 'cancelled' : 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = message;
    this.emitEvent(job, 'error', { status: job.status, message });
    this.finish(job);
  }

  setPublished(id: string, resourceId: string | null, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (resourceId) job.resourceId = resourceId;
    if (error) job.publishError = error;
    this.emitEvent(job, 'status', { status: job.status, resource_id: job.resourceId, publish_error: job.publishError });
    this.persist(job);
  }

  private finish(job: Job): void {
    if (this.running === job.id) this.running = null;
    this.persist(job);
    this.emit('finish', job);
    this.trim();
    this.pump();
  }

  /** Returns 'queued' | 'running' | null depending on what was cancelled. */
  cancel(id: string): 'queued' | 'running' | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      this.queue = this.queue.filter(q => q !== id);
      this.onError(id, 'cancelled', true);
      return 'queued';
    }
    if (job.status === 'running') return 'running';
    return null;
  }

  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') return false;
    this.queue = this.queue.filter(q => q !== id);
    this.jobs.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {
      // not persisted
    }
    return true;
  }

  /** Mark the running job failed (e.g. worker crashed). */
  failRunning(message: string): void {
    if (this.running) this.onError(this.running, message);
  }
}
