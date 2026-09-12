import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ensureDirs } from '@/lib/agent';
import { assertSafeSlug, assertSafeTestId, P, readIfPresent } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Write the agent's output into the same files the CLI uses:
 *   analysis → thinking/analysis/<feature>-<date>.md
 *   missions → missions/draft/<TEST_ID>.json
 *
 * Missions are validated against the real schema before anything is written.
 * Saving an invalid mission would just move the failure to a later, more
 * confusing point.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      featureSlug?: string;
      analysisMarkdown?: string;
      missions?: Record<string, unknown>[];
    };

    ensureDirs();
    const written: string[] = [];
    const rejected: { testId: string; errors: string[] }[] = [];

    if (body.analysisMarkdown?.trim()) {
      const slug = body.featureSlug?.trim() || 'analysis';
      assertSafeSlug(slug);
      const today = new Date().toISOString().slice(0, 10);
      const file = path.join(P.analysisDir, `${slug}-${today}.md`);
      fs.writeFileSync(file, body.analysisMarkdown, 'utf8');
      written.push(path.relative(P.root, file).split(path.sep).join('/'));
    }

    if (body.missions?.length) {
      const schemaRaw = readIfPresent(P.missionSchema);
      if (!schemaRaw) throw new Error('Mission schema not found — cannot validate.');
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(JSON.parse(schemaRaw));

      for (const mission of body.missions) {
        const testId = String(mission.test_id ?? '');
        assertSafeTestId(testId);

        if (!validate(mission)) {
          rejected.push({
            testId,
            errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()),
          });
          continue;
        }

        const file = path.join(P.missionsDraft, `${testId}.json`);
        fs.writeFileSync(file, `${JSON.stringify(mission, null, 2)}\n`, 'utf8');
        written.push(path.relative(P.root, file).split(path.sep).join('/'));
      }
    }

    return NextResponse.json({ written, rejected });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
