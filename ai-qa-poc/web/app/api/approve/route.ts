import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeTestId, P } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Gate 1, from the UI — the same rules as scripts/approve.ts:
 *   move missions/draft/<ID>.json → missions/approved/<ID>.json
 *   stamp approved_by / approved_at
 *   pin the requirement's content hash so later edits to it are detectable
 *
 * Deliberately no bulk-approve-everything endpoint. If approving feels like a
 * formality, the gate is not doing its job.
 */

function hashRequirementFile(locator: string): string | undefined {
  const withoutFragment = locator.split('#')[0];
  if (!withoutFragment || /^[a-z]+:\/\//i.test(withoutFragment)) return undefined;
  const resolved = path.resolve(P.root, withoutFragment);
  if (!resolved.startsWith(P.root) || !fs.existsSync(resolved)) return undefined;
  const text = fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;
}

/** What's sitting in draft/ and approved/, for the UI to render. */
export async function GET() {
  const read = (dir: string) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  return NextResponse.json({
    draft: read(P.missionsDraft),
    approved: read(P.missionsApproved),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      testId?: string;
      approvedBy?: string;
      reviewMinutes?: number;
      editsMade?: boolean;
    };

    const testId = (body.testId ?? '').trim();
    assertSafeTestId(testId);

    const approvedBy = (body.approvedBy ?? '').trim();
    if (!approvedBy) {
      return NextResponse.json({ error: 'Refusing to approve anonymously — enter your name.' }, { status: 400 });
    }

    const src = path.join(P.missionsDraft, `${testId}.json`);
    if (!fs.existsSync(src)) {
      return NextResponse.json({ error: `No draft mission ${testId}.json` }, { status: 404 });
    }

    const mission = JSON.parse(fs.readFileSync(src, 'utf8')) as Record<string, unknown>;

    // Pin the requirement as it reads today, so a later edit to it is visible
    // at run time rather than silently invalidating an approved mission.
    const ref = mission.requirement_ref as { locator?: string; content_hash?: string } | undefined;
    let pinned: string | undefined;
    if (ref?.locator) {
      pinned = hashRequirementFile(ref.locator);
      if (pinned) ref.content_hash = pinned;
    }

    mission.approval = {
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      edits_made: Boolean(body.editsMade),
      ...(typeof body.reviewMinutes === 'number' ? { review_minutes: body.reviewMinutes } : {}),
    };

    fs.mkdirSync(P.missionsApproved, { recursive: true });
    fs.writeFileSync(path.join(P.missionsApproved, `${testId}.json`), `${JSON.stringify(mission, null, 2)}\n`, 'utf8');
    fs.rmSync(src);

    return NextResponse.json({
      approved: testId,
      approvedBy,
      requirementPinned: pinned ?? null,
      note: 'Commit the move so the approval is part of the audit trail.',
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
