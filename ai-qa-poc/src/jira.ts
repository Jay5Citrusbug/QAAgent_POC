/**
 * Jira ticket → requirement text.
 *
 * Stories arrive as Jira tickets, and the whole pipeline reads
 * input/feature-<name>/requirement.md. This turns the one into the other,
 * whatever shape the ticket came in:
 *
 *   - live from Jira's REST API (optional; needs JIRA_BASE_URL + credentials)
 *   - a JSON export (a single issue, `{ issues: [...] }` from a search, or an array)
 *   - an XML export ("Export → XML" in the Jira UI)
 *   - text copied straight out of the ticket
 *
 * The important part is structure, not formatting: every acceptance criterion
 * becomes its own heading, so `npm run verify` can report which criteria no
 * test case cites — a gap that is invisible while the ACs are one paragraph.
 *
 * Nothing is inferred. A ticket with no acceptance criteria produces a
 * requirement with none, and the Thinking Agent then asks about it rather than
 * inventing some.
 */

export interface Ticket {
  key: string;
  summary: string;
  type?: string;
  priority?: string;
  status?: string;
  labels?: string[];
  components?: string[];
  /** Markdown, with the acceptance-criteria section removed when it was found inside. */
  description: string;
  /** One entry per criterion, as written. */
  acceptance: string[];
  links?: { relation: string; key: string; summary?: string }[];
  subtasks?: { key: string; summary?: string }[];
  comments?: { author?: string; created?: string; body: string }[];
  url?: string;
  source: string;
}

const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;

// --- Atlassian Document Format (REST v3) → markdown ---------------------------

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

function adfInline(n: AdfNode): string {
  if (n.type === 'text') {
    let t = n.text ?? '';
    for (const m of n.marks ?? []) {
      if (m.type === 'strong') t = `**${t}**`;
      else if (m.type === 'em') t = `_${t}_`;
      else if (m.type === 'code') t = `\`${t}\``;
      else if (m.type === 'strike') t = `~~${t}~~`;
      else if (m.type === 'link') t = `[${t}](${String(m.attrs?.href ?? '')})`;
    }
    return t;
  }
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return `@${String(n.attrs?.text ?? 'user').replace(/^@/, '')}`;
  if (n.type === 'emoji') return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
  if (n.type === 'inlineCard') return String(n.attrs?.url ?? '');
  if (n.type === 'status') return `[${String(n.attrs?.text ?? '')}]`;
  if (n.type === 'date') return new Date(Number(n.attrs?.timestamp ?? 0)).toISOString().slice(0, 10);
  return (n.content ?? []).map(adfInline).join('');
}

function adfBlock(n: AdfNode, depth = 0): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case 'doc':
      return kids.map((k) => adfBlock(k, depth)).filter(Boolean).join('\n\n');
    case 'paragraph':
      return kids.map(adfInline).join('');
    case 'heading':
      return `${'#'.repeat(Math.min(6, Number(n.attrs?.level ?? 3)))} ${kids.map(adfInline).join('')}`;
    case 'bulletList':
    case 'orderedList':
      return kids
        .map((li, i) => {
          const marker = n.type === 'orderedList' ? `${i + 1}.` : '-';
          const body = (li.content ?? []).map((c) => adfBlock(c, depth + 1)).join('\n');
          return `${'  '.repeat(depth)}${marker} ${body.replace(/\n/g, `\n${'  '.repeat(depth + 1)}`)}`;
        })
        .join('\n');
    case 'taskList':
      return kids.map((t) => `- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${(t.content ?? []).map(adfInline).join('')}`).join('\n');
    case 'codeBlock':
      return `\`\`\`\n${kids.map(adfInline).join('')}\n\`\`\``;
    case 'blockquote':
    case 'panel':
      return kids.map((k) => `> ${adfBlock(k, depth)}`).join('\n');
    case 'rule':
      return '---';
    case 'table': {
      const rows = kids.map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((x) => adfBlock(x)).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ')));
      if (rows.length === 0) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '_[attachment — see the ticket]_';
    default:
      return kids.length ? kids.map((k) => adfBlock(k, depth)).join('\n') : adfInline(n);
  }
}

/** A Jira rich-text field: ADF object, wiki/plain string, or nothing. */
export function richText(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.includes('<') && /<\/?(p|div|br|ul|li|h\d)\b/i.test(v) ? htmlToMarkdown(v) : wikiToMarkdown(v);
  if (typeof v === 'object' && (v as AdfNode).type === 'doc') return adfBlock(v as AdfNode).trim();
  return String(v);
}

// --- HTML (XML export, rendered fields) → markdown -----------------------------

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

export function htmlToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replace(/\r/g, '')
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${'#'.repeat(Number(l))} ${t}\n\n`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>|<\/div>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(ul|ol)>/gi, '\n\n')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '_$2_')
      .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
      .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<\/t[hd]>\s*<t[hd][^>]*>/gi, ' | ')
      .replace(/<tr[^>]*>\s*<t[hd][^>]*>/gi, '\n| ')
      .replace(/<\/t[hd]>\s*<\/tr>/gi, ' |')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The common subset of Jira wiki markup (REST v2 / Server). */
export function wikiToMarkdown(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/^h([1-6])\.\s*/gm, (_, l) => `${'#'.repeat(Number(l))} `)
    .replace(/^\s*\*\s+/gm, '- ')
    .replace(/^\s*#\s+/gm, '1. ')
    .replace(/\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/g, '```\n$1\n```')
    .replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, '```\n$1\n```')
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, '[$1]($2)')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1**$2**')
    .replace(/\{\{([^}]+)\}\}/g, '`$1`')
    .trim();
}

// --- acceptance criteria ---------------------------------------------------------

const AC_HEADING = /^(?:#{1,6}\s*|\*\*)?\s*(acceptance\s+criteria|acs?|definition\s+of\s+done)\b[^\n]*$/im;

/**
 * Split an acceptance-criteria block into individual criteria.
 *
 * Recognises Gherkin scenarios, numbered/bulleted lists and "AC1:" lines —
 * the shapes teams actually write. Anything else stays as one criterion rather
 * than being cut somewhere arbitrary.
 */
export function splitCriteria(block: string): string[] {
  const text = block.replace(/\r/g, '').trim();
  if (!text) return [];

  // Gherkin: a new criterion at each Scenario, or at each Given after a Then.
  if (/^\s*(scenario|given)\b/im.test(text)) {
    const out: string[] = [];
    let cur: string[] = [];
    let seenThen = false;
    for (const line of text.split('\n')) {
      const l = line.replace(/^\s*[-*]\s+/, '').trim();
      if (!l) continue;
      const startsNew = /^scenario\b/i.test(l) || (/^given\b/i.test(l) && seenThen);
      if (startsNew && cur.length) {
        out.push(cur.join('\n'));
        cur = [];
        seenThen = false;
      }
      if (/^then\b/i.test(l)) seenThen = true;
      cur.push(l);
    }
    if (cur.length) out.push(cur.join('\n'));
    return out;
  }

  // "AC1: ..." / "AC-2 - ..."
  if (/^\s*ac[\s-]?\d+\b/im.test(text)) {
    return text
      .split(/\n(?=\s*ac[\s-]?\d+\b)/i)
      .map((s) => s.replace(/^\s*ac[\s-]?\d+\s*[:.)\-–]\s*/i, '').trim())
      .filter(Boolean);
  }

  // Lists: top-level items, continuation lines kept with their item.
  if (/^\s*([-*•]|\d+[.)]|\[[ x]\])\s+/m.test(text)) {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const m = /^([-*•]|\d+[.)])\s+(\[[ x]\]\s*)?(.*)$/.exec(line);
      if (m) out.push(m[3]!.replace(/^ac[\s-]?\d+\s*[:.)\-–]\s*/i, '').trim());
      else if (line.trim() && out.length) out[out.length - 1] += `\n${line.trim()}`;
    }
    return out.filter(Boolean);
  }

  return [text];
}

/** Pull an "Acceptance Criteria" section out of a description, if there is one. */
export function extractCriteria(markdown: string): { description: string; acceptance: string[] } {
  const m = AC_HEADING.exec(markdown);
  if (!m) return { description: markdown.trim(), acceptance: [] };
  const start = m.index;
  const after = markdown.slice(start + m[0].length);
  // The section ends at the next heading of any level (or a bold pseudo-heading).
  const end = after.search(/\n\s*(#{1,6}\s|\*\*[^*\n]+\*\*\s*\n)/);
  const block = end === -1 ? after : after.slice(0, end);
  const rest = markdown.slice(0, start) + (end === -1 ? '' : after.slice(end));
  return { description: rest.trim(), acceptance: splitCriteria(block) };
}

// --- sources ----------------------------------------------------------------------

type JiraIssueJson = {
  key?: string;
  self?: string;
  fields?: Record<string, unknown>;
  renderedFields?: Record<string, unknown>;
};

/** One issue from Jira REST JSON (v2 or v3). `acField` is the custom field holding ACs, if the team uses one. */
export function fromIssueJson(issue: JiraIssueJson, source: string, acField?: string, baseUrl?: string): Ticket {
  const f = issue.fields ?? {};
  const name = (v: unknown) => (v && typeof v === 'object' ? String((v as { name?: string }).name ?? '') : undefined);
  const rawDescription = richText(f.description ?? issue.renderedFields?.description);
  const fromField = acField ? richText(f[acField] ?? issue.renderedFields?.[acField]) : '';
  const split = extractCriteria(rawDescription);
  const acceptance = fromField ? splitCriteria(fromField) : split.acceptance;
  const description = fromField ? rawDescription : split.description;

  const links = ((f.issuelinks as Record<string, unknown>[] | undefined) ?? []).map((l) => {
    const t = l.type as { name?: string; inward?: string; outward?: string } | undefined;
    const out = l.outwardIssue as { key: string; fields?: { summary?: string } } | undefined;
    const inw = l.inwardIssue as { key: string; fields?: { summary?: string } } | undefined;
    const other = out ?? inw;
    return { relation: (out ? t?.outward : t?.inward) ?? t?.name?.toLowerCase() ?? 'relates to', key: other?.key ?? '?', summary: other?.fields?.summary };
  });
  const comments = (((f.comment as { comments?: Record<string, unknown>[] } | undefined)?.comments) ?? []).map((c) => ({
    author: (c.author as { displayName?: string } | undefined)?.displayName,
    created: String(c.created ?? '').slice(0, 10),
    body: richText(c.body),
  }));

  return {
    key: issue.key ?? 'UNKNOWN',
    summary: String(f.summary ?? '(no summary)'),
    type: name(f.issuetype),
    priority: name(f.priority),
    status: name(f.status),
    labels: (f.labels as string[] | undefined) ?? [],
    components: ((f.components as { name: string }[] | undefined) ?? []).map((c) => c.name),
    description,
    acceptance,
    links,
    subtasks: ((f.subtasks as { key: string; fields?: { summary?: string } }[] | undefined) ?? []).map((s) => ({ key: s.key, summary: s.fields?.summary })),
    comments,
    url: baseUrl && issue.key ? `${baseUrl.replace(/\/$/, '')}/browse/${issue.key}` : undefined,
    source,
  };
}

export function fromJsonExport(data: unknown, source: string, acField?: string): Ticket[] {
  const list = Array.isArray(data) ? data : (data as { issues?: unknown[] }).issues ?? [data];
  return (list as JiraIssueJson[]).filter((i) => i && (i.key || i.fields)).map((i) => fromIssueJson(i, source, acField));
}

/** Jira's "Export → XML" (an RSS document with one <item> per issue). */
export function fromXmlExport(xml: string, source: string): Ticket[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const tag = (s: string, t: string) => {
    const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(s);
    return m ? decodeEntities(m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : undefined;
  };
  return items.map((it) => {
    const split = extractCriteria(htmlToMarkdown(tag(it, 'description') ?? ''));
    // Some teams keep ACs in a custom field; the export lists those by name.
    const acField = /<customfield[^>]*>\s*<customfieldname>\s*Acceptance Criteria\s*<\/customfieldname>[\s\S]*?<customfieldvalue>([\s\S]*?)<\/customfieldvalue>/i.exec(it);
    const acceptance = acField ? splitCriteria(htmlToMarkdown(decodeEntities(acField[1]!))) : split.acceptance;
    return {
      key: tag(it, 'key') ?? 'UNKNOWN',
      summary: tag(it, 'summary') ?? '(no summary)',
      type: tag(it, 'type'),
      priority: tag(it, 'priority'),
      status: tag(it, 'status'),
      labels: (it.match(/<label>([^<]+)<\/label>/g) ?? []).map((l) => l.replace(/<\/?label>/g, '')),
      components: (it.match(/<component>([^<]+)<\/component>/g) ?? []).map((c) => c.replace(/<\/?component>/g, '')),
      description: split.description,
      acceptance,
      url: tag(it, 'link'),
      source,
    };
  });
}

/** Text copied out of the ticket. First line is the title; a key anywhere in it is picked up. */
export function fromPlainText(text: string, source: string, fallbackKey?: string): Ticket {
  const lines = text.replace(/\r/g, '').split('\n');
  const firstIdx = lines.findIndex((l) => l.trim());
  const first = (lines[firstIdx] ?? '').replace(/^#+\s*/, '').trim();
  const key = KEY_RE.exec(first)?.[0] ?? KEY_RE.exec(text)?.[0] ?? fallbackKey ?? 'STORY';
  const summary = first.replace(KEY_RE, '').replace(/^[\s:–\-|]+/, '').trim() || first;
  const body = lines.slice(firstIdx + 1).join('\n');
  const { description, acceptance } = extractCriteria(body);
  return { key, summary, description, acceptance, source };
}

// --- live REST ----------------------------------------------------------------------

export interface JiraConfig {
  baseUrl: string;
  headers: Record<string, string>;
  acField?: string;
}

/**
 * Credentials from the environment only — never from a file in this repo.
 *   Cloud:          JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 *   Server / DC:    JIRA_BASE_URL, JIRA_PAT
 *   AC custom field (optional): JIRA_AC_FIELD=customfield_10035
 */
export function jiraConfig(): JiraConfig | { missing: string } {
  const baseUrl = process.env.JIRA_BASE_URL;
  if (!baseUrl) return { missing: 'JIRA_BASE_URL' };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.JIRA_PAT) headers.authorization = `Bearer ${process.env.JIRA_PAT}`;
  else if (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
    headers.authorization = `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`;
  } else return { missing: 'JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/DC)' };
  return { baseUrl: baseUrl.replace(/\/$/, ''), headers, ...(process.env.JIRA_AC_FIELD ? { acField: process.env.JIRA_AC_FIELD } : {}) };
}

export async function fetchIssue(cfg: JiraConfig, key: string): Promise<{ ticket: Ticket; raw: unknown }> {
  const fields = ['summary', 'description', 'issuetype', 'priority', 'status', 'labels', 'components', 'issuelinks', 'subtasks', 'comment', ...(cfg.acField ? [cfg.acField] : [])];
  // v3 first (Cloud, ADF); v2 for Server/DC.
  for (const version of ['3', '2']) {
    const res = await fetch(`${cfg.baseUrl}/rest/api/${version}/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`, {
      headers: cfg.headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404 && version === '3') continue;
    if (res.status === 401 || res.status === 403) throw new Error(`Jira refused the request (${res.status}) — check the credentials and that you can see ${key}.`);
    if (!res.ok) throw new Error(`Jira returned ${res.status} for ${key}.`);
    const raw = (await res.json()) as JiraIssueJson;
    return { ticket: fromIssueJson(raw, `${cfg.baseUrl} (REST v${version})`, cfg.acField, cfg.baseUrl), raw };
  }
  throw new Error(`${key} was not found.`);
}

// --- rendering ------------------------------------------------------------------------

const START = (k: string) => `<!-- jira:${k} start -->`;
const END = (k: string) => `<!-- jira:${k} end -->`;

/** The ticket as a requirement block. Headings are what test cases cite and verify traces. */
export function renderTicket(t: Ticket, opts: { withComments?: boolean } = {}): string {
  const L: string[] = [START(t.key), ''];
  L.push(`## ${t.key} — ${t.summary}`, '');
  const meta = [
    t.type && `Type: ${t.type}`,
    t.priority && `Priority: ${t.priority}`,
    t.status && `Status: ${t.status}`,
    t.components?.length && `Components: ${t.components.join(', ')}`,
    t.labels?.length && `Labels: ${t.labels.join(', ')}`,
    t.url && `Ticket: ${t.url}`,
  ].filter(Boolean);
  if (meta.length) L.push(`> ${meta.join(' · ')}`, '');
  L.push(t.description.trim() || '_The ticket has no description._', '');

  if (t.acceptance.length) {
    t.acceptance.forEach((ac, i) => {
      const firstLine = ac.split('\n')[0]!.replace(/^(scenario|given)\s*:?\s*/i, '').slice(0, 90);
      L.push(`### ${t.key} AC-${i + 1} — ${firstLine}`, '', ac, '');
    });
  } else {
    L.push(`### ${t.key} — acceptance criteria`, '', '_None were written on the ticket. Every expected behaviour is therefore a question for the author, not something to assume._', '');
  }

  if (t.links?.length || t.subtasks?.length) {
    L.push(`#### ${t.key} — related work`, '');
    for (const l of t.links ?? []) L.push(`- ${l.relation} ${l.key}${l.summary ? ` — ${l.summary}` : ''}`);
    for (const s of t.subtasks ?? []) L.push(`- subtask ${s.key}${s.summary ? ` — ${s.summary}` : ''}`);
    L.push('');
  }
  if (opts.withComments && t.comments?.length) {
    L.push(`#### ${t.key} — discussion on the ticket`, '', '_Comments often settle questions the description leaves open. They are context, not requirements, until the author confirms them._', '');
    for (const c of t.comments) L.push(`- **${c.author ?? 'someone'}** (${c.created ?? ''}): ${c.body.replace(/\n+/g, ' ')}`);
    L.push('');
  }
  L.push(END(t.key));
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Put a ticket block into an existing requirement file: replace the block for
 * the same key, or insert before "Known gaps" (or at the end).
 */
export function mergeIntoRequirement(existing: string, t: Ticket, block: string, title: string): string {
  const template = !existing.trim() || /Replace this with the real requirement/.test(existing);
  if (template) {
    return `# Requirement — ${title}\n\n> Imported from Jira. Re-import a ticket to refresh it; approved tests warn when the text they were approved against changes.\n\n${block}\n\n## Known gaps in this requirement\n\nRecorded by the Thinking Agent at Gate 2, as questions for the author.\n`;
  }
  const s = existing.indexOf(START(t.key));
  const e = existing.indexOf(END(t.key));
  if (s !== -1 && e !== -1) return existing.slice(0, s) + block + existing.slice(e + END(t.key).length);
  const gaps = existing.search(/^## Known gaps/m);
  return gaps === -1 ? `${existing.trimEnd()}\n\n${block}\n` : `${existing.slice(0, gaps)}${block}\n\n${existing.slice(gaps)}`;
}
