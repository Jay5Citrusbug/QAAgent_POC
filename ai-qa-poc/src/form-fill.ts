import type { ControlFact, PageReality } from './inspector.js';

/**
 * Turning "complete every required checkout field" into actual keystrokes.
 *
 * A form is the one place where an intent legitimately describes many controls
 * in a single sentence. Everywhere else, one step means one control, and the
 * binder's one-step-one-target rule holds. On a form it collapses: the binder
 * picked whichever single textbox scored highest, filled it with a placeholder,
 * submitted, and the resulting mission proved nothing — while reporting green,
 * which is worse than reporting nothing.
 *
 * Two questions have to be answered to do better, and the capture now records
 * enough to answer both without asking a human anything per-feature:
 *
 *  - **Which field?** A field's accessible name is usually its placeholder, so
 *    the checkout email box is called "john@example.com" and shares no word
 *    with "supply an email address". Its `type` and `name` attributes do say
 *    what it is for, and those are what get matched here.
 *
 *  - **With what value?** The intent says the *kind* of value it wants — "an
 *    email address that is not a valid email", "a phone number containing
 *    letters" — which is a specification, not a gap. A fixed value per purpose
 *    satisfies it deterministically, with no model in the path.
 *
 * Nothing here is domain knowledge about shops. It is knowledge about forms,
 * and it applies to a signup page or a support ticket equally.
 */

export type FieldPurpose =
  | 'email'
  | 'phone'
  | 'postal'
  | 'person_name'
  | 'country'
  | 'region'
  | 'city'
  | 'address'
  | 'password'
  | 'other';

export interface FormField {
  control: ControlFact;
  purpose: FieldPurpose;
  url: string;
  /** A select, which is chosen from rather than typed into. */
  isChoice: boolean;
}

/**
 * What a field is for, read from the markup rather than guessed from prose.
 *
 * Order matters: `type="email"` is decisive, but a field named `email_confirm`
 * with `type="text"` is still an email box, so the attribute is consulted too.
 */
const PURPOSE_PATTERNS: { purpose: FieldPurpose; type?: RegExp; attr: RegExp }[] = [
  { purpose: 'email', type: /^email$/, attr: /e-?mail/i },
  { purpose: 'phone', type: /^tel$/, attr: /phone|mobile|tel(ephone)?\b/i },
  { purpose: 'password', type: /^password$/, attr: /pass(word|wd)/i },
  { purpose: 'postal', attr: /pin\s?code|postal|post\s?code|zip/i },
  { purpose: 'country', attr: /country|nation/i },
  { purpose: 'region', attr: /state|province|region|county/i },
  { purpose: 'city', attr: /city|town|suburb/i },
  { purpose: 'address', attr: /address|street|line1|line2/i },
  { purpose: 'person_name', attr: /(full|first|last|given|family|sur)\s?name|^name$|username/i },
];

export function purposeOf(c: ControlFact): FieldPurpose {
  const f = c.field;
  if (!f) return 'other';
  const hay = `${f.attr} ${f.placeholder} ${c.name}`;
  for (const p of PURPOSE_PATTERNS) {
    if (p.type && p.type.test(f.type)) return p.purpose;
    if (p.attr.test(hay)) return p.purpose;
  }
  return 'other';
}

/**
 * The fields of one form, in the order they should be filled.
 *
 * Selects come first because dependent dropdowns are ordinary: a state list is
 * empty until a country is chosen, and the capture shows exactly that — the
 * country select carries eight options, state and city carry none. Filling in
 * capture order keeps that dependency satisfied without encoding which field
 * depends on which.
 */
export function formFieldsOn(pages: PageReality[], urlHint?: string): FormField[] {
  const byUrl = new Map<string, FormField[]>();

  for (const page of pages) {
    for (const c of page.controls) {
      if (!c.field) continue;
      if (c.field.type === 'hidden' || c.field.type === 'submit') continue;
      const list = byUrl.get(page.url) ?? [];
      // The same field can appear in several captured states of one page.
      if (list.some((f) => f.control.field?.attr === c.field?.attr && f.control.name === c.name)) continue;
      list.push({ control: c, purpose: purposeOf(c), url: page.url, isChoice: c.field.type === 'select' });
      byUrl.set(page.url, list);
    }
  }

  let chosen: FormField[] = [];
  if (urlHint) {
    for (const [url, fields] of byUrl) {
      if (url.includes(urlHint) && fields.length > chosen.length) chosen = fields;
    }
  }
  if (chosen.length === 0) {
    for (const fields of byUrl.values()) if (fields.length > chosen.length) chosen = fields;
  }

  return [...chosen.filter((f) => f.isChoice), ...chosen.filter((f) => !f.isChoice)];
}

/** A sentence about the form as a whole, rather than about one box in it. */
export function describesWholeForm(text: string): boolean {
  return (
    /\b(every|all|each)\b[^.]{0,40}\bfields?\b/i.test(text) ||
    /\b(fill in|complete|populate)\b[^.]{0,30}\bform\b/i.test(text) ||
    /\b(valid|required)\s+(checkout\s+)?details\b/i.test(text)
  );
}

/** "…except one, leaving that one empty" — the whole point of a required-field test. */
export function leavesOneEmpty(text: string): boolean {
  return /\bexcept\s+(one|for one)\b/i.test(text) || /\bleav\w*\b[^.]{0,30}\b(empty|blank)\b/i.test(text);
}

/** The intent asking for a value the product should reject. */
export function wantsInvalidValue(text: string): boolean {
  return /\b(not a valid|isn'?t valid|invalid|malformed|badly formatted|wrong format|containing letters|too short|too long)\b/i.test(
    text,
  );
}

/**
 * Which single field a step is talking about, when it talks about one.
 *
 * Matched on purpose first ("an email address that is not a valid email" →
 * email), then on the field's own attribute name appearing in the sentence, so
 * a form with a field nobody has a word for is still addressable.
 */
export function fieldMentionedIn(text: string, fields: FormField[]): FormField | undefined {
  const t = text.toLowerCase();
  const mentions: { purpose: FieldPurpose; test: RegExp }[] = [
    { purpose: 'email', test: /\be-?mail\b/i },
    { purpose: 'phone', test: /\b(phone|mobile|telephone)\b/i },
    { purpose: 'postal', test: /\b(pin\s?code|postal code|post\s?code|zip)\b/i },
    { purpose: 'password', test: /\bpassword\b/i },
    { purpose: 'country', test: /\bcountry\b/i },
    { purpose: 'region', test: /\b(state|province|region)\b/i },
    { purpose: 'city', test: /\bcity|town\b/i },
    { purpose: 'address', test: /\b(address|street)\b/i },
    { purpose: 'person_name', test: /\b(full name|first name|last name|your name)\b/i },
  ];

  for (const m of mentions) {
    if (!m.test.test(t)) continue;
    const hit = fields.find((f) => f.purpose === m.purpose);
    if (hit) return hit;
  }

  return fields.find((f) => {
    const attr = f.control.field?.attr;
    return attr ? t.includes(attr.toLowerCase()) : false;
  });
}

/**
 * The value to put in a field of this purpose.
 *
 * Fixed per purpose, so two runs of the same mission type the same thing and a
 * failure is always about the product. `{run_id}` is substituted by the
 * executor and is what makes a created order traceable afterwards.
 *
 * The invalid variants are chosen to be unambiguously wrong in the one way the
 * intent names — letters in a phone number, no `@` in an email — rather than
 * merely unusual, so a product that accepts them has definitely failed to
 * validate rather than merely been lenient.
 */
export function valueFor(purpose: FieldPurpose, invalid: boolean): string {
  if (invalid) {
    switch (purpose) {
      case 'email':
        return 'not-an-email';
      case 'phone':
        return 'abcdefghij';
      case 'postal':
        return 'not-a-pincode';
      case 'password':
        return 'x';
      default:
        return '!!';
    }
  }
  switch (purpose) {
    case 'email':
      return 'ai-qa-{run_id}@example.com';
    case 'phone':
      return '5551234567';
    case 'postal':
      return '123456';
    case 'password':
      return 'Aa1!aaaaaa';
    case 'person_name':
      return 'AI QA {run_id}';
    case 'address':
      return '1 Test Street';
    case 'city':
    case 'region':
    case 'country':
      return FIRST_OPTION;
    default:
      return 'AI QA {run_id}';
  }
}

/**
 * "Whichever option this dropdown offers first."
 *
 * A country list is in the capture; the state list that depends on it is not,
 * because it does not exist until a country is picked. Naming a specific state
 * at bind time would be guessing about data the capture never saw. When the
 * requirement does not care which region is chosen — and for a checkout
 * validation test it does not — picking the first real option is what a human
 * tester does, and it is fully deterministic.
 *
 * Where the requirement DOES care, the intent says so and `fieldMentionedIn`
 * plus a stated value take over.
 */
export const FIRST_OPTION = '{first_option}';
