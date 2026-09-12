import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PATHS, rel } from './config.js';

/**
 * Evidence collection.
 *
 * The bar: a human QA must be able to review the result without re-running the
 * test. Everything here exists to meet that bar and nothing more — screenshots
 * on every step are a cost paid again on every run, forever.
 */
export class Evidence {
  readonly dir: string;
  private readonly logFile: string;
  private readonly items = new Set<string>();
  private readonly lines: string[] = [];

  constructor(
    readonly testId: string,
    readonly runId: string,
  ) {
    this.dir = path.join(PATHS.runs, testId, runId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.logFile = path.join(this.dir, 'execution.log');
    this.add(this.logFile);
  }

  /** One log line per meaningful event, flushed immediately so a crash still leaves a trail. */
  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.lines.push(line);
    fs.appendFileSync(this.logFile, `${line}\n`, 'utf8');
    if (process.env.QUIET !== 'true') console.log(line);
  }

  add(file: string): void {
    this.items.add(rel(file));
  }

  async screenshot(page: Page, name: string): Promise<string | undefined> {
    const file = path.join(this.dir, `${name}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      this.add(file);
      return file;
    } catch (err) {
      this.log(`Screenshot "${name}" failed: ${String(err)}`);
      return undefined;
    }
  }

  writeText(name: string, contents: string): string {
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, contents, 'utf8');
    this.add(file);
    return file;
  }

  writeJson(name: string, data: unknown): string {
    return this.writeText(name, `${JSON.stringify(data, null, 2)}\n`);
  }

  get tracePath(): string {
    return path.join(this.dir, 'trace.zip');
  }

  /** Only keep the trace when it earns its place. */
  registerTraceIfPresent(): void {
    if (fs.existsSync(this.tracePath)) this.add(this.tracePath);
  }

  discardTrace(): void {
    try {
      if (fs.existsSync(this.tracePath)) fs.rmSync(this.tracePath);
    } catch {
      /* leaving a stray trace behind is not worth failing a run over */
    }
  }

  list(): string[] {
    return [...this.items].sort();
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function newRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  const salt = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${salt}`;
}
