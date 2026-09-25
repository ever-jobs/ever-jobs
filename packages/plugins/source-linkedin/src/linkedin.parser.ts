import * as cheerio from 'cheerio';
import { DescriptionFormat, JobPostDto, ScraperInputDto, Site } from '@ever-jobs/models';
import {
  NO_POSTED_TIME,
  PostedTime,
  extractLdJsonBlocks,
  markdownConverter,
  parseJobPostingLd,
  parseLocationList,
  plainConverter,
  postedFromRelativeLabel,
  postedFromTimestamp,
  postedTimeFields,
  toDateOnly,
} from '@ever-jobs/common';
import type {
  LinkedInCard,
  LinkedInCompanyDetails,
  LinkedInJobDetail,
  LinkedInJobPost,
  LinkedInLegacyFlags,
  LinkedInSearchPage,
} from './linkedin.types';
import {
  canonicalJobUrl,
  collapseWhitespace,
  detectRemoteSignal,
  externalHttpUrl,
  extractLinkedInJobId,
  isJobRemote,
  jobTypeFromEmploymentType,
  licdnMediaUrl,
  normalizeCompanyUrl,
  parseApplicants,
  parseCompanyIndustry,
  parseCriteria,
  parseJobLevel,
  parseJobType,
  parseLegacyCardPay,
  parseLinkedInPay,
  unwrapLinkedInRedirect,
} from './linkedin.utils';

/**
 * Pure HTML parsing for the LinkedIn guest pages (Spec 1701). Nothing here does
 * I/O, so every rule is unit-testable against fixtures; `LinkedInService`
 * keeps only requests, pacing, merging and diagnostics.
 */

// ── Search cards ─────────────────────────────────────────────────────────────

function firstLicdnImage(scope: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): string | null {
  let logo: string | null = null;
  scope.each((_, el) => {
    logo = licdnMediaUrl($(el).attr('data-delayed-url'));
    return logo === null;
  });
  return logo;
}

function parseCard($: cheerio.CheerioAPI, card: cheerio.Cheerio<any>): LinkedInCard | null {
  const title = collapseWhitespace(card.find('.base-search-card__title').first().text());
  if (!title) return null;

  const subtitle = card.find('.base-search-card__subtitle').first();
  const companyLink = subtitle.find('a').first();
  const time = card.find('time').first();
  const salary = card.find('.job-search-card__salary-info').first();

  return {
    jobId: extractLinkedInJobId(card),
    href: card.find('.base-search-card__full-link, a.base-card__full-link').first().attr('href')?.trim() || null,
    title,
    companyName: collapseWhitespace(companyLink.text()) || collapseWhitespace(subtitle.text()) || null,
    companyHref: companyLink.attr('href')?.trim() || null,
    companyLogo: firstLicdnImage(card.find('img.artdeco-entity-image[data-delayed-url]'), $),
    locationText: collapseWhitespace(card.find('.job-search-card__location').first().text()),
    timeDatetime: time.attr('datetime')?.trim() || null,
    timeText: time.length ? collapseWhitespace(time.text()) || null : null,
    salaryText: salary.length ? collapseWhitespace(salary.text()) : null,
  };
}

/**
 * Parse a guest search fragment. `cardCount` counts every card, including
 * ones that cannot be parsed, because the next page's `start` is an item offset.
 */
export function parseSearchCards(html: string): LinkedInSearchPage {
  const $ = cheerio.load(typeof html === 'string' ? html : '');
  const items = $('li').has('.base-search-card');
  const cards: LinkedInCard[] = [];
  items.each((_, el) => {
    const card = parseCard($, $(el));
    if (card) cards.push(card);
  });
  return { cardCount: items.length, cards };
}

/**
 * The card's posting time. The `<time>` label ("26 minutes ago") refines the
 * `datetime` attribute to an instant only when it is sub-day and agrees with
 * it (Spec 1696). `datePosted` always equals what the attribute alone gave
 * before, so no existing value changes.
 */
export function cardPostedTime(card: Pick<LinkedInCard, 'timeText' | 'timeDatetime'>, fetchedAtMs: number): PostedTime {
  const attributeDate = card.timeDatetime ? toDateOnly(card.timeDatetime) : null;
  const posted = postedFromRelativeLabel(card.timeText, fetchedAtMs, attributeDate);
  if (attributeDate !== null && posted.datePosted !== attributeDate) {
    return { ...NO_POSTED_TIME, datePosted: attributeDate };
  }
  return posted;
}

/**
 * Map one card to a job. `null` when the card has no usable id (the default)
 * or no link (legacy ids).
 */
export function cardToJobPost(
  card: LinkedInCard,
  input: Pick<ScraperInputDto, 'isRemote'>,
  fetchedAtMs: number,
  legacy: Pick<LinkedInLegacyFlags, 'ids' | 'pay' | 'remote'>,
): LinkedInJobPost | null {
  let id: string;
  let jobUrl: string;
  let companyUrl: string | null;
  if (legacy.ids) {
    const slugUrl = card.href?.split('?')[0];
    if (!slugUrl) return null;
    id = `li-${slugUrl.match(/view\/([^/]+)/)?.[1] ?? ''}`;
    jobUrl = slugUrl;
    companyUrl = card.companyHref;
  } else {
    if (!card.jobId) return null;
    id = `li-${card.jobId}`;
    jobUrl = canonicalJobUrl(card.jobId);
    companyUrl = normalizeCompanyUrl(card.companyHref);
  }

  const compensation = legacy.pay
    ? card.salaryText !== null
      ? parseLegacyCardPay(card.salaryText)
      : null
    : parseLinkedInPay(card.salaryText);

  const locationParsed = parseLocationList([card.locationText || null]);
  const remoteByFilter = !legacy.remote && input.isRemote === true;
  const isRemote = legacy.remote
    ? isJobRemote(card.title, '', card.locationText, { legacy: true }) || locationParsed.remoteMentioned
    : remoteByFilter || detectRemoteSignal(card.title, card.locationText) || locationParsed.remoteMentioned;
  const workFromHomeType = remoteByFilter ? 'Remote' : locationParsed.workFromHomeType;

  return new JobPostDto({
    id,
    title: card.title,
    companyName: card.companyName,
    companyUrl,
    jobUrl,
    location: locationParsed.location,
    ...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {}),
    compensation,
    ...postedTimeFields(cardPostedTime(card, fetchedAtMs)),
    isRemote,
    ...(workFromHomeType ? { workFromHomeType } : {}),
    ...(card.companyLogo ? { companyLogo: card.companyLogo } : {}),
    site: Site.LINKEDIN,
  }) as LinkedInJobPost;
}

// ── Job view page ────────────────────────────────────────────────────────────

export interface ParseJobDetailOptions {
  /** Pre-1701 description selector, raw seniority and job type from every criterion. */
  legacyDetail?: boolean;
  /** Pre-1701 pay: the detail page's pay block is not read. */
  legacyPay?: boolean;
}

function convertDescription(rawHtml: string, format?: DescriptionFormat): string {
  if (format === DescriptionFormat.MARKDOWN) return markdownConverter(rawHtml) ?? rawHtml;
  if (format === DescriptionFormat.PLAIN) return plainConverter(rawHtml) ?? rawHtml;
  return rawHtml;
}

/** `code#applyUrl` holds a commented, quoted URL; LinkedIn wraps the target in `?url=`. */
function applyUrlFromCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/<!--|-->/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/&amp;/g, '&')
    .trim();
  if (!text) return null;
  const direct = externalHttpUrl(text);
  if (direct) return direct;
  try {
    return externalHttpUrl(new URL(text).searchParams.get('url'));
  } catch {
    return null;
  }
}

function seniority(value: string | undefined): string | null {
  if (!value || /^not applicable$/i.test(value)) return null;
  return value;
}

/**
 * Parse a job view page (`/jobs/view/<id>`). Every query is scoped to the
 * posting itself (`.top-card-layout`, `.decorated-job-posting__details`); the
 * "similar jobs" cards, which carry their own pay and dates, are dropped
 * first so they can never leak in.
 */
export function parseJobDetail(
  html: string,
  format?: DescriptionFormat,
  options: ParseJobDetailOptions = {},
): LinkedInJobDetail {
  const source = typeof html === 'string' ? html : '';
  const ld = parseJobPostingLd(source)[0];
  const posted = ld?.datePosted ? postedFromTimestamp(ld.datePosted) : { ...NO_POSTED_TIME };

  const $ = cheerio.load(source);
  const companyIdMeta = $('meta[name="companyId"]').attr('content')?.trim() ?? '';
  const applyCode = $('code#applyUrl').first().html();
  $('.similar-jobs, .main-job-card').remove();

  const scope = $('.top-card-layout, .decorated-job-posting__details');
  const within = (selector: string): cheerio.Cheerio<any> =>
    scope.length ? scope.find(selector) : $(selector);

  let rawHtml: string | null = null;
  if (options.legacyDetail) {
    const el = $('.show-more-less-html__markup, .description__text');
    if (el.length) rawHtml = el.html() ?? '';
  } else {
    const markup = within('.show-more-less-html__markup').first();
    if (markup.length) {
      rawHtml = markup.html() ?? '';
    } else {
      const section = within('.description__text').first();
      if (section.length) {
        const clone = section.clone();
        clone.find('button, .show-more-less-html__button').remove();
        rawHtml = clone.html() ?? '';
      }
    }
  }

  const criteriaEl = within('.description__job-criteria-list').first();
  const criteria = parseCriteria($, criteriaEl);
  const employmentType = jobTypeFromEmploymentType(criteria['employment type']);

  return {
    description: rawHtml === null ? null : convertDescription(rawHtml, format),
    jobLevel: options.legacyDetail ? parseJobLevel($, criteriaEl) : seniority(criteria['seniority level']),
    jobType: options.legacyDetail
      ? parseJobType($, criteriaEl, { allCriteria: true })
      : employmentType
        ? [employmentType]
        : null,
    jobFunction: criteria['job function'] ?? null,
    companyIndustry: options.legacyDetail
      ? parseCompanyIndustry($, criteriaEl)
      : (criteria['industries'] ?? null),
    companySourceId: /^\d+$/.test(companyIdMeta) ? companyIdMeta : null,
    applicants: parseApplicants(
      collapseWhitespace(within('.num-applicants__caption').first().text()) ||
        within('.num-applicants__figure').first().text(),
    ),
    compensation: options.legacyPay
      ? null
      : parseLinkedInPay(within('.compensation__salary-range .compensation__salary').first().text()),
    jobUrlDirect: applyUrlFromCode(applyCode),
    companyLogo: firstLicdnImage($('.top-card-layout img[data-delayed-url]:not(.face-pile__image)'), $),
    posted,
  };
}

// ── Company page ─────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

const MAX_LD_NODES = 500;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(node: JsonObject, type: string): boolean {
  const value = node['@type'];
  return value === type || (Array.isArray(value) && value.includes(type));
}

/** The first `Organization` node across the blocks, their arrays and their `@graph`s. */
function findOrganization(blocks: unknown[]): JsonObject | null {
  const queue: unknown[] = [...blocks];
  for (let seen = 0; queue.length > 0 && seen < MAX_LD_NODES; seen++) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!isObject(node)) continue;
    if (hasType(node, 'Organization')) return node;
    const graph = node['@graph'];
    if (Array.isArray(graph)) queue.push(...graph);
    else if (isObject(graph)) queue.push(graph);
  }
  return null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isObject(value)) return text(value['name']);
  return null;
}

function ldWebsite(sameAs: unknown): string | null {
  const candidates = Array.isArray(sameAs) ? sameAs : [sameAs];
  for (const candidate of candidates) {
    const url = typeof candidate === 'string' ? externalHttpUrl(candidate) : null;
    if (url) return url;
  }
  return null;
}

function ldAddress(value: unknown): string | null {
  const address = Array.isArray(value) ? value.find(isObject) : value;
  if (!isObject(address)) return text(address);
  const regionPostal = [text(address['addressRegion']), text(address['postalCode'])].filter(Boolean).join(' ');
  const parts = [
    text(address['streetAddress']),
    text(address['addressLocality']),
    regionPostal || null,
    text(address['addressCountry']),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

function ldEmployees(value: unknown): string | null {
  const raw = isObject(value) ? value['value'] : value;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return raw.trim();
  return null;
}

function ldLogo(value: unknown): string | null {
  if (typeof value === 'string') return licdnMediaUrl(value);
  if (!isObject(value)) return null;
  return licdnMediaUrl(text(value['contentUrl'])) ?? licdnMediaUrl(text(value['url']));
}

/**
 * Parse a public company page (`/company/<slug>`): the schema.org
 * `Organization` JSON-LD first, then the "About us" list for anything it lacks.
 * The website is never a linkedin.com URL (a redirect wrapper is unwrapped).
 * `null` when the page yields nothing.
 */
export function parseCompanyPage(html: string): LinkedInCompanyDetails | null {
  const source = typeof html === 'string' ? html : '';
  const org = findOrganization(extractLdJsonBlocks(source));

  const $ = cheerio.load(source);
  const about = (key: string): cheerio.Cheerio<any> => $(`[data-test-id="about-us__${key}"]`).first();
  const aboutValue = (key: string): string | null => collapseWhitespace(about(key).find('dd').first().text()) || null;

  const websiteBlock = about('website');
  const domWebsite =
    externalHttpUrl(unwrapLinkedInRedirect(websiteBlock.find('a[href]').first().attr('href'))) ??
    externalHttpUrl(collapseWhitespace(websiteBlock.find('dd').first().text()));
  const size = aboutValue('size');

  const details: LinkedInCompanyDetails = {
    website: (org ? ldWebsite(org['sameAs']) : null) ?? domWebsite,
    address: (org ? ldAddress(org['address']) : null) ?? aboutValue('headquarters'),
    employeesLd: org ? ldEmployees(org['numberOfEmployees']) : null,
    sizeBand: size ? size.replace(/\s*employees?$/i, '').trim() || null : null,
    industry: aboutValue('industry'),
    description: (org ? text(org['description']) : null) ?? (collapseWhitespace(about('description').text()) || null),
    logo: org ? ldLogo(org['logo']) : null,
  };

  return Object.values(details).some((value) => value !== null) ? details : null;
}
