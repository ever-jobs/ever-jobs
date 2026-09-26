import * as cheerio from 'cheerio';
import { htmlToPlainText } from '@ever-jobs/common';
import {
  SOFTY_CONTRACT_BADGE_REGEX,
  SOFTY_DESCRIPTION_MAX_CHARS,
  SOFTY_DETAIL_PATH,
  SOFTY_DETAIL_PATH_REGEX,
  SOFTY_LISTING_PATH,
  SOFTY_OFFER_LINK_REGEX,
  SOFTY_PAGE_PARAM,
  SOFTY_PUBLISHED_REGEX,
  SOFTY_ROOT_DOMAIN,
  SOFTY_SCHEDULE_REGEX,
  SOFTY_SCHEME,
} from './softy.constants';
import { SoftyCardJob, SoftyDetail } from './softy.types';

/**
 * Pure parsers for the current Softy markup (Spec 1691). Everything here is
 * synchronous and side-effect free so it can be unit-tested against fixtures; the
 * legacy `/offre/{ID}-{slug}` window parser stays in `SoftyService`.
 */

/** `https://{tenant}.softy.pro` */
export function softyBaseUrl(tenant: string): string {
  return `${SOFTY_SCHEME}${tenant}.${SOFTY_ROOT_DOMAIN}`;
}

/** Canonical detail URL: `https://{tenant}.softy.pro/offers/{ID}`. */
export function softyOfferUrl(tenant: string, id: string): string {
  return `${softyBaseUrl(tenant)}${SOFTY_DETAIL_PATH}${id}`;
}

/** Listing page URL: `https://{tenant}.softy.pro/offers?page={page}`. */
export function softyListingPageUrl(tenant: string, page: number): string {
  return `${softyBaseUrl(tenant)}${SOFTY_LISTING_PATH}?${SOFTY_PAGE_PARAM}=${page}`;
}

/**
 * The offer id of a current detail URL (`/offers/{ID}`) on `host`, or null. Relative
 * URLs resolve against `host`; other hosts, `/offers/{ID}/apply`, listing pages and
 * legacy `/offre/…` URLs return null.
 */
export function softyOfferIdFromUrl(url: string | null | undefined, host: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim(), `${SOFTY_SCHEME}${host}/`);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== host.toLowerCase()) return null;
  if (parsed.search && new URLSearchParams(parsed.search).has(SOFTY_PAGE_PARAM)) return null;
  const m = SOFTY_DETAIL_PATH_REGEX.exec(parsed.pathname);
  return m ? m[1] : null;
}

/** True when the HTML carries legacy `/offre/{ID}-{slug}` anchors. */
export function hasLegacySoftyLinks(html: string): boolean {
  return new RegExp(SOFTY_OFFER_LINK_REGEX.source, 'i').test(html);
}

/**
 * True when the HTML is the current Softy design system (`data-slot` attributes) —
 * an empty current board, as opposed to a tenant still on the legacy markup.
 */
export function looksLikeCurrentSoftyMarkup(html: string): boolean {
  return /\bdata-slot\s*=/i.test(html);
}

/**
 * Parse one listing page (`/offers?page=N`): the offer cards and every page number
 * the pagination links to. Cards are keyed on their `/offers/{ID}` anchor; fields
 * come from the `data-slot` elements inside the card.
 */
export function parseSoftyListingPage(
  html: string,
  tenant: string,
): { cards: SoftyCardJob[]; pages: number[] } {
  const cards: SoftyCardJob[] = [];
  const pages = new Set<number>();
  if (typeof html !== 'string' || !html) return { cards, pages: [] };

  const host = `${tenant}.${SOFTY_ROOT_DOMAIN}`;
  const $ = cheerio.load(html);

  // Every anchor, grouped by offer id (a card can link to its offer more than once).
  const anchorsById = new Map<string, cheerio.Cheerio<any>[]>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const page = listingPageNumber(href, host);
    // A disabled "Suivant" on the last page must not announce a page that does not exist.
    if (page !== null && $(el).attr('aria-disabled') !== 'true') pages.add(page);
    const id = softyOfferIdFromUrl(href, host);
    if (!id) return;
    const list = anchorsById.get(id) ?? [];
    list.push($(el));
    anchorsById.set(id, list);
  });

  for (const [id, anchors] of anchorsById) {
    const anchor = anchors.find((a) => a.find('[data-slot="joboffer-title"]').length > 0) ?? anchors[0];
    const container = cardContainer($, anchor, host);

    const title =
      text(container.find('[data-slot="joboffer-title"]').first()) ??
      text(container.find('h3, h2').first()) ??
      shortText(text(anchor));
    const locations = locationTexts($, container);
    const badges = badgeTexts($, container);
    const publishedRaw = text(container.find('[data-slot="joboffer-published-at"]').first());
    const publishedMatch = publishedRaw ? SOFTY_PUBLISHED_REGEX.exec(publishedRaw) : null;

    cards.push({
      id,
      url: softyOfferUrl(tenant, id),
      title,
      location: locations[0] ?? null,
      locations,
      contractType: contractFromBadges(badges),
      schedule: scheduleFromBadges(badges),
      badges,
      publishedAt: publishedMatch ? publishedMatch[0] : publishedRaw,
    });
  }

  return { cards, pages: [...pages].sort((a, b) => a - b) };
}

/**
 * Parse a detail page. Current markup: `h1`, location / badge slots and the `.prose`
 * sections (with their `h2` headings) as cleaned HTML. When no `.prose` exists the
 * description falls back to `og:description`, then to the whole page's text (the
 * pre-1691 behaviour, still right for legacy pages). Returns null for an empty page.
 */
export function parseSoftyDetailPage(html: string): SoftyDetail | null {
  if (typeof html !== 'string' || !html.trim()) return null;
  const $ = cheerio.load(html);

  const ogTitle = cleanText($('meta[property="og:title"]').attr('content'));
  const title =
    text($('h1').first()) ?? ogTitle ?? cleanText($('title').first().text());
  const locations = locationTexts($, $.root());
  const badges = badgeTexts($, $.root());
  const publishedRaw = text($('[data-slot="joboffer-published-at"]').first());
  const publishedMatch = publishedRaw ? SOFTY_PUBLISHED_REGEX.exec(publishedRaw) : null;

  let description: string | null = proseDescription($);
  let descriptionIsHtml = description !== null;
  if (!description) {
    description = capText(cleanText($('meta[property="og:description"]').attr('content')));
  }
  if (!description) {
    // Legacy / unknown markup: the page text (line breaks kept), as before Spec 1691.
    $('script, style, noscript, template').remove();
    description = capText(htmlToPlainText($.html()).trim() || null);
    descriptionIsHtml = false;
  }

  if (!title && !description && locations.length === 0 && badges.length === 0) return null;

  return {
    title,
    locations,
    contractType: contractFromBadges(badges),
    schedule: scheduleFromBadges(badges),
    badges,
    publishedAt: publishedMatch ? publishedMatch[0] : publishedRaw,
    description,
    descriptionIsHtml,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Page number of a listing link (`/offers?page=N` on `host`), else null. */
function listingPageNumber(href: string | undefined, host: string): number | null {
  if (!href) return null;
  let parsed: URL;
  try {
    parsed = new URL(href.trim(), `${SOFTY_SCHEME}${host}/`);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== host.toLowerCase()) return null;
  if (!/^(?:\/[a-z]{2})?\/offers\/?$/i.test(parsed.pathname)) return null;
  const raw = parsed.searchParams.get(SOFTY_PAGE_PARAM);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const page = Number(raw);
  return page >= 1 ? page : null;
}

/**
 * The element holding a card's fields: the anchor itself when it wraps the
 * `data-slot` fields (the live markup), else the nearest ancestor that has them and
 * links to this offer only.
 */
function cardContainer($: cheerio.CheerioAPI, anchor: cheerio.Cheerio<any>, host: string): cheerio.Cheerio<any> {
  if (anchor.find('[data-slot^="joboffer-"]').length > 0) return anchor;
  const id = softyOfferIdFromUrl(anchor.attr('href'), host);
  let node = anchor.parent();
  for (let level = 0; level < 5 && node.length > 0; level++) {
    if (node.is('body, html, main')) break;
    const ids = new Set<string>();
    node.find('a[href]').each((_, a) => {
      const other = softyOfferIdFromUrl($(a).attr('href'), host);
      if (other) ids.add(other);
    });
    if (ids.size > 1 || (id && !ids.has(id))) break;
    if (node.find('[data-slot^="joboffer-"]').length > 0) return node;
    node = node.parent();
  }
  return anchor;
}

function locationTexts($: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>): string[] {
  const out: string[] = [];
  scope.find('[data-slot="joboffer-locations"]').each((_, block) => {
    const ps = $(block).find('p');
    if (ps.length > 0) {
      ps.each((__, p) => {
        const t = text($(p));
        if (t && !out.includes(t)) out.push(t);
      });
    } else {
      const t = text($(block));
      if (t && !out.includes(t)) out.push(t);
    }
  });
  return out;
}

function badgeTexts($: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>): string[] {
  const out: string[] = [];
  scope.find('[data-slot="badge"]').each((_, el) => {
    const t = text($(el));
    if (t && !out.includes(t)) out.push(t);
  });
  return out;
}

/**
 * The contract badge: the first badge that is a contract token on its own or with a
 * duration (CDI, "CDD - 6 Mois"…), per `SOFTY_CONTRACT_BADGE_REGEX`.
 */
function contractFromBadges(badges: string[]): string | null {
  return badges.find((badge) => SOFTY_CONTRACT_BADGE_REGEX.test(badge)) ?? null;
}

function scheduleFromBadges(badges: string[]): string | null {
  for (const badge of badges) {
    const m = SOFTY_SCHEDULE_REGEX.exec(badge);
    if (m) return cleanText(m[0]);
  }
  return null;
}

/** Tags dropped from description HTML, with their content. */
const DROP_TAGS = 'script, style, noscript, template, iframe, object, embed, svg, form, button, input, select, textarea';

/**
 * The `.prose` sections as one cleaned HTML fragment: each section keeps the `h2`
 * heading that labels it; attributes are stripped (except safe `href`s); scripts,
 * styles, forms and media are removed. Blocks are appended whole until the next one
 * would pass `SOFTY_DESCRIPTION_MAX_CHARS`. Null when the page has no `.prose`.
 */
function proseDescription($: cheerio.CheerioAPI): string | null {
  const sections = $('.prose').filter((_, el) => $(el).parents('.prose').length === 0);
  if (sections.length === 0) return null;

  const blocks: string[] = [];
  const usedHeadings = new Set<unknown>();
  sections.each((_, el) => {
    const section = $(el);
    const ownHeading = section.children().first().is('h1, h2, h3');
    if (!ownHeading) {
      const candidates = [
        section.prevAll('h2, h3').first(),
        section.parent().children('h2, h3').first(),
        section.parent().prevAll('h2, h3').first(),
      ];
      const found = candidates.find((c) => c.length > 0 && text(c) !== null);
      if (found && !usedHeadings.has(found.get(0))) {
        usedHeadings.add(found.get(0));
        blocks.push(`<h2>${escapeHtml(text(found) as string)}</h2>`);
      }
    }
    const clone = section.clone();
    clone.find(DROP_TAGS).remove();
    clone.find('*').each((__, node) => {
      const attribs = (node as any).attribs as Record<string, string> | undefined;
      if (!attribs) return;
      for (const name of Object.keys(attribs)) {
        const keep = name === 'href' && /^(https?:|mailto:)/i.test(attribs[name] ?? '');
        if (!keep) $(node).removeAttr(name);
      }
    });
    collectBlocks($, clone, blocks);
  });

  let html = '';
  for (const block of blocks) {
    if (html.length + block.length <= SOFTY_DESCRIPTION_MAX_CHARS) {
      html += block;
      continue;
    }
    if (!html) html = truncatedParagraph(block);
    break;
  }
  return cleanText(htmlToPlainText(html)) ? html : null;
}

/** Wrapper elements descended into, so the cap can cut between their children. */
const WRAPPER_TAGS = new Set(['div', 'section', 'article', 'main']);

/** Block-level children that make a wrapper safe to split. */
const BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'dl', 'div', 'section', 'article', 'main', 'table', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure',
]);

/** A wrapper whose content is only block elements (no loose text / inline runs). */
function isSplittableWrapper(node: any): boolean {
  const name = String(node?.name ?? '').toLowerCase();
  if (!WRAPPER_TAGS.has(name)) return false;
  const children: any[] = node.children ?? [];
  let blocks = 0;
  for (const child of children) {
    if (child.type === 'text') {
      if (cleanText(child.data)) return false;
      continue;
    }
    if (child.type !== 'tag') continue;
    if (!BLOCK_TAGS.has(String(child.name).toLowerCase())) return false;
    blocks++;
  }
  return blocks > 0;
}

/**
 * Split an element's content into top-level blocks: loose text becomes `<p>`, a
 * wrapper holding only block elements is descended into, anything else (p, ul, h3,
 * table, a div with inline content…) is one block.
 */
function collectBlocks($: cheerio.CheerioAPI, parent: cheerio.Cheerio<any>, blocks: string[]): void {
  parent.contents().each((_, child) => {
    if (child.type === 'text') {
      const t = cleanText((child as any).data);
      if (t) blocks.push(`<p>${escapeHtml(t)}</p>`);
      return;
    }
    if (child.type !== 'tag') return;
    if (isSplittableWrapper(child)) {
      collectBlocks($, $(child), blocks);
      return;
    }
    const outer = $.html(child);
    if (cleanText(htmlToPlainText(outer))) blocks.push(outer);
  });
}

/** A block too long for the cap on its own, as `<p>text…</p>` within the cap. */
function truncatedParagraph(block: string): string {
  const plain = cleanText(htmlToPlainText(block)) ?? '';
  const budget = SOFTY_DESCRIPTION_MAX_CHARS - '<p></p>'.length;
  let body = '';
  for (const ch of plain) {
    const escaped = escapeHtml(ch);
    if (body.length + escaped.length > budget) break;
    body += escaped;
  }
  return `<p>${body}</p>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function capText(value: string | null): string | null {
  if (!value) return null;
  return value.length > SOFTY_DESCRIPTION_MAX_CHARS ? value.slice(0, SOFTY_DESCRIPTION_MAX_CHARS) : value;
}

/** Element text with whitespace collapsed; null when empty. */
function text(el: cheerio.Cheerio<any>): string | null {
  if (!el || el.length === 0) return null;
  return cleanText(el.text().replace(/\s+/g, ' '));
}

function shortText(value: string | null): string | null {
  return value && value.length <= 200 ? value : null;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(/\s+/g, ' ').trim();
  return v.length > 0 ? v : null;
}
