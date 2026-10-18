import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertSafeTestId, P } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const run = promisify(execFile);

/**
 * Gate 2.5, from the UI — by running the CLI, not by reimplementing it.
 *
 * This route used to stamp the approval itself: read the JSON, hash the
 * requirement, write the file. It was a faithful copy of `scripts/approve.ts`
 * on the day it was written, and then the CLI gained things it did not:
 * schema validation, the lint warnings, and — the one that matters — the
 * refusal to approve a mission carrying unresolved binding exceptions.
 *
 * So a mission the terminal refused ("O1 was bound to the closest thing
 * available, not a faithful check") approved with one click in the browser. The
 * gates refusing is the whole claim of this system, and a second entry point
 * that does not enforce them is worse than not having the entry point.
 *
 * Delegating removes the possibility rather than fixing this instance of it.
 * There is now one implementation of Gate 2.5, it lives in `scripts/approve.ts`,
 * and anything added there applies here on the next request with no code change
 * — the same reasoning `lib/paths.ts` already gives for not copying the system
 * prompt or the schema.
 *
 * The cost is a spawned process per approval. For a tool one QA lead runs
 * locally that is not a cost worth optimising, and it buys the guarantee that
 * the browser and the terminal cannot disagree about what is approvable.
 */

/** What is sitting in draft/ and approved/, for the UI to render. */
export async function GET() {
  const read = (dir: string) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];

  /**
   * Binding exceptions travel with the listing so the UI can show what a human
   * is being asked to accept. Approving blind and approving after reading are
   * the same click otherwise, which is how a gate becomes a formality.
   */
  const exceptionsFor = (file: string) => {
    try {
      const mission = JSON.parse(fs.readFileSync(path.join(P.missionsDraft, file), 'utf8')) as {
        binding?: { exceptions?: { kind: string; where: string; summary: string }[] };
      };
      return mission.binding?.exceptions ?? [];
    } catch {
      return [];
    }
  };

  const draft = read(P.missionsDraft);
  return NextResponse.json({
    draft,
    approved: read(P.missionsApproved),
    exceptions: Object.fromEntries(
      draft.map((f) => [path.basename(f, '.json'), exceptionsFor(f)]).filter(([, e]) => (e as unknown[]).length),
    ),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      testId?: string;
      approvedBy?: string;
      reviewMinutes?: number;
      editsMade?: boolean;
      /** The human says they have read the binding exceptions — the CLI's --reviewed. */
      reviewedExceptions?: boolean;
    };

    const testId = (body.testId ?? '').trim();
    assertSafeTestId(testId);

    const approvedBy = (body.approvedBy ?? '').trim();
    if (!approvedBy) {
      return NextResponse.json({ error: 'Refusing to approve anonymously — enter your name.' }, { status: 400 });
    }
    // A name that looks like a flag would be read as one by the CLI.
    if (approvedBy.startsWith('--')) {
      return NextResponse.json({ error: 'That name is not usable.' }, { status: 400 });
    }

    /**
     * Spawn node against tsx's own entry point rather than `npx tsx`.
     *
     * On Windows `npx` is `npx.cmd`, which `execFile` cannot resolve without a
     * shell — and a shell is exactly what must not be involved when a test id
     * and a person's name are being passed through. `process.execPath` is the
     * node already running this, so there is no PATH lookup either.
     */
    const tsx = path.join(P.root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!fs.existsSync(tsx)) {
      return NextResponse.json(
        { error: 'tsx is not installed in the parent project — run npm install there.' },
        { status: 500 },
      );
    }

    const args = [tsx, 'scripts/approve.ts', testId, '--by', approvedBy];
    if (typeof body.reviewMinutes === 'number' && Number.isFinite(body.reviewMinutes)) {
      args.push('--minutes', String(body.reviewMinutes));
    }
    if (body.editsMade) args.push('--edited');
    if (body.reviewedExceptions) args.push('--reviewed');

    // execFile, not exec: arguments are passed as an array and never go through
    // a shell, so a test id or a name cannot become a command.
    try {
      const { stdout } = await run(process.execPath, args, {
        cwd: P.root,
        windowsHide: true,
        timeout: 60_000,
      });
      return NextResponse.json({
        approved: testId,
        approvedBy,
        output: stdout.trim(),
        note: 'Commit the move so the approval is part of the audit trail.',
      });
    } catch (err) {
      /**
       * A non-zero exit is the gate doing its job — an unresolved binding
       * exception, a schema failure, an id that is not in draft. The CLI's own
       * message is better than anything this could paraphrase, so it is passed
       * through verbatim rather than flattened into "approval failed".
       */
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const detail = (e.stderr || e.stdout || e.message || 'Approval was refused.').trim();
      return NextResponse.json({ error: detail, refusedBy: 'gate' }, { status: 409 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
