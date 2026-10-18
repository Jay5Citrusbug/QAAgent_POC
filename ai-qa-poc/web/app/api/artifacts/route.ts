import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { P } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Result = { test_id?: string; status?: string; failure_classification?: string; confidence?: string; feature?: string; build?: string; [key: string]: unknown };

function files(dir: string, extension: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(extension)).sort().reverse();
}

function readText(file: string, max = 80_000): string {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function latestResults(): Result[] {
  if (!fs.existsSync(P.runs)) return [];
  const results: Result[] = [];
  for (const testId of fs.readdirSync(P.runs)) {
    const testDir = path.join(P.runs, testId);
    if (!fs.statSync(testDir).isDirectory()) continue;
    const run = fs
      .readdirSync(testDir)
      .filter((name) => !name.endsWith('-replay') && fs.existsSync(path.join(testDir, name, 'result.json')))
      .sort()
      .at(-1);
    if (!run) continue;
    const result = readJson<Result>(path.join(testDir, run, 'result.json'));
    if (result) results.push({ ...result, test_id: result.test_id ?? testId });
  }
  return results.sort((a, b) => String(a.test_id).localeCompare(String(b.test_id)));
}

function missionFiles(dir: string): { id: string; content: string }[] {
  return files(dir, '.json').map((file) => ({
    id: path.basename(file, '.json'),
    content: readText(path.join(dir, file), 120_000),
  }));
}

export async function GET() {
  const analyses = files(P.analysisDir, '.md');
  const reports = files(P.reports, '.md').slice(0, 12);
  const defects = files(P.defects, '.json').map((file) => {
    const value = readJson<{ fingerprint?: string; title?: string; status?: string; severity?: string }>(path.join(P.defects, file));
    return { file, ...value };
  });
  const latestAnalysis = analyses[0];
  const latestReport = reports[0];
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    analysis: latestAnalysis ? { file: latestAnalysis, content: readText(path.join(P.analysisDir, latestAnalysis)) } : null,
    missions: { draft: missionFiles(P.missionsDraft), approved: missionFiles(P.missionsApproved) },
    runs: latestResults(),
    defects,
    reports: reports.map((file) => ({ file, content: file === latestReport ? readText(path.join(P.reports, file)) : undefined })),
  });
}