import { RemoteOkJob, RemoteOkMeta } from '../../src/remoteok.types';

/**
 * Synthetic RemoteOK feed rows (Spec 1707). Companies and titles are
 * invented; only the wire shape and the encoding defects are the board's:
 * UTF-8 bytes serialised as Latin-1 (written here as \xNN escapes), the
 * mixed-case `remoteOK.com` host, `url === apply_url`, empty logos and
 * `salary_* = 0` for "unknown".
 */

/** Fixed clock for every test: 2026-09-24T20:00:00Z. */
export const NOW_MS = Date.UTC(2026, 8, 24, 20, 0, 0);
export const NOW_S = NOW_MS / 1000;

export const META: RemoteOkMeta = { last_updated: NOW_S - 60, legal: 'test terms' };

/** A job row plus `ageHours`, which sets `epoch` and `date` relative to {@link NOW_MS}. */
export type JobOverrides = Partial<Omit<RemoteOkJob, 'id'>> & { id?: string | number; ageHours?: number };

let counter = 0;

/** Restart the id sequence (call in `beforeEach` for stable ids). */
export function resetJobIds(): void {
  counter = 0;
}

function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isoWithOffset(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** One feed row with sane defaults; `overrides` win. Ages default to 1 h, 2 h, 3 h... in call order. */
export function job(overrides: JobOverrides = {}): RemoteOkJob {
  counter += 1;
  const { ageHours, ...fields } = overrides;
  const id = fields.id ?? String(1000000 + counter);
  const position = fields.position ?? 'Software Engineer';
  const company = fields.company ?? 'Acme Robotics';
  const epoch = NOW_S - (ageHours ?? counter) * 3600;
  const slug = `remote-${kebab(position)}-${kebab(company)}-${id}`;
  const url = `https://remoteOK.com/remote-jobs/${slug}`;
  return {
    slug,
    id,
    epoch,
    date: isoWithOffset(epoch),
    company,
    company_logo: '',
    position,
    tags: ['dev', 'engineer'],
    description: '<p>Build reliable systems with a small team.</p>',
    location: '',
    apply_url: url,
    salary_min: 0,
    salary_max: 0,
    logo: '',
    url,
    ...fields,
  };
}

/** A full feed body: the metadata row first, as the board sends it. */
export function feed(...rows: unknown[]): unknown[] {
  return [META, ...rows];
}

/** The axios-shaped response the mocked client resolves with. */
export function ok(data: unknown): { data: unknown; status: number } {
  return { data, status: 200 };
}

/** Double-encoded text seen on the wire, as \xNN escapes, with its repaired form. */
export const MOJIBAKE = {
  emDashTitle: 'Lead \xE2\x80\x94 Ops',
  emDashTitleFixed: 'Lead \u{2014} Ops',
  company: 'Caf\xC3\xA9 Globex',
  companyFixed: 'Caf\xE9 Globex',
  description: '<p>Our Widget\xE2\x84\xA2 platform \xE2\x80\x94 grabaci\xC3\xB3n \xF0\x9F\x98\x85</p>',
  descriptionFixedText: 'Our Widget\u{2122} platform \u{2014} grabaci\xF3n \u{1F605}',
  arabicLocation: '\xD9\x85\xD8\xB3\xD9\x82\xD8\xB7, \xD9\x85\xD8\xB3\xD9\x82\xD8\xB7 \xD8\xB9\xD9\x85\xD8\xA7\xD9\x86',
  arabicCity: '\u{645}\u{633}\u{642}\u{637}',
  truncatedTitle: 'Customer Support Agent \xC2\xB7 \xC2',
  truncatedTitleFixed: 'Customer Support Agent',
  tag: 'caf\xC3\xA9',
  tagFixed: 'caf\xE9',
};

/** Any lead+continuation pair left in output means the repair missed something. */
export const MOJIBAKE_PATTERN = /[\xC2-\xF4][\x80-\xBF]/;
