import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  CompensationDto,
  CompensationInterval,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
  DescriptionFormat,
  looksLikeChallenge,
} from '@ever-jobs/models';
import {
  BrowserPool,
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  parseLocationList,
  toDateOnly,
} from '@ever-jobs/common';
import {
  WELLFOUND_ATS_HOST,
  WELLFOUND_ATS_HYDRATE_MS,
  WELLFOUND_ATS_MAX_PAGES,
} from './wellfound_ats.constants';
import {
  WellfoundAtsJobListing,
  WellfoundAtsNextData,
  WellfoundAtsRemoteConfig,
  WellfoundAtsStartup,
} from './wellfound_ats.types';

@SourcePlugin({
  site: Site.WELLFOUND_ATS,
  name: 'Wellfound ATS',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WellfoundAtsService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(WellfoundAtsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const slug = this.resolveSlug(input);
    if (!slug) {
      this.logger.warn('Wellfound ATS: no companySlug or /company/{slug} companyUrl provided');
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('bad_input', 'no companySlug or Wellfound companyUrl provided'),
      );
    }

    const proxy = input.proxies?.[0] ?? undefined;
    const resultsWanted = input.resultsWanted ?? 100;
    const timeoutMs = (input.requestTimeout ?? 30) * 1000;
    let page;

    try {
      page = await BrowserPool.getPage({ stealth: true, proxy });
      const listings = new Map<string, WellfoundAtsJobListing>();
      // Apollo JobListingRemoteConfig ref → kind, for THIS scrape only. It must
      // not live on the (singleton) service: a shared map grows for the life of
      // the process and leaks entries between concurrent scrapes.
      const remoteConfigKind: Record<string, string | undefined> = {};
      let startupName: string | null = null;
      let declaredPages = 0;
      let pagesRead = 0;
      let blockedDiagnostics: ScrapeDiagnostics | null = null;

      for (let pageNum = 1; pageNum <= WELLFOUND_ATS_MAX_PAGES; pageNum++) {
        const url = this.boardUrl(slug, pageNum);
        this.logger.log(`Wellfound ATS: navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await this.delay(WELLFOUND_ATS_HYDRATE_MS);

        const html = (await page.content().catch(() => '')) as string;
        if (looksLikeChallenge(html)) {
          blockedDiagnostics = new ScrapeDiagnostics('blocked', 'Cloudflare challenge page');
          break;
        }

        const nextDataJson = (await page.evaluate(
          `(() => { const s = document.getElementById('__NEXT_DATA__'); return s ? s.textContent : null; })()`,
        )) as string | null;

        if (!nextDataJson) {
          this.logger.warn('Wellfound ATS: __NEXT_DATA__ not found — page structure may have changed');
          if (listings.size === 0) {
            return new JobResponseDto(
              [],
              new ScrapeDiagnostics('empty', 'no __NEXT_DATA__ payload on board page'),
            );
          }
          break;
        }

        let data: Record<string, any>;
        try {
          const parsed = JSON.parse(nextDataJson) as WellfoundAtsNextData;
          data = parsed.props?.pageProps?.apolloState?.data ?? {};
        } catch {
          this.logger.error('Wellfound ATS: failed to parse __NEXT_DATA__ JSON');
          if (listings.size === 0) {
            return new JobResponseDto(
              [],
              new ScrapeDiagnostics('empty', 'unparseable __NEXT_DATA__ payload'),
            );
          }
          break;
        }

        const before = listings.size;
        for (const entry of Object.values(data)) {
          if (entry?.__typename === 'JobListing' && entry.id) {
            const listing = entry as unknown as WellfoundAtsJobListing;
            if (!listings.has(listing.id)) listings.set(listing.id, listing);
          } else if (entry?.__typename === 'Startup' && !startupName) {
            startupName = (entry as WellfoundAtsStartup).name ?? null;
          }
          // Connection records carry totalPageCount for the truncation check.
          for (const [k, v] of Object.entries(entry ?? {})) {
            if (k.startsWith('jobListingsConnection(')) {
              const tp = (v as { totalPageCount?: number })?.totalPageCount;
              if (typeof tp === 'number' && tp > declaredPages) declaredPages = tp;
            }
          }
        }
        pagesRead++;
        Object.assign(remoteConfigKind, this.collectRemoteConfigKind(data));

        if (listings.size === before) break; // ?page= ignored or past the end
        if (listings.size >= resultsWanted) break;
        if (declaredPages && pagesRead >= declaredPages) break;
      }

      if (blockedDiagnostics) {
        const partial = [...listings.values()];
        if (partial.length) {
          const posts = partial
            .slice(0, resultsWanted)
            .map((l) => this.mapListing(l, startupName, remoteConfigKind, input.descriptionFormat))
            .filter((p): p is JobPostDto => p !== null);
          return new JobResponseDto(posts, new ScrapeDiagnostics('partial', 'Cloudflare challenge mid-pagination'));
        }
        return new JobResponseDto([], blockedDiagnostics);
      }

      if (declaredPages > pagesRead) {
        this.logger.warn(
          `Wellfound ATS: board declares ${declaredPages} pages but only ${pagesRead} yielded listings — possible truncation`,
        );
      }

      const jobPosts = [...listings.values()]
        .slice(0, resultsWanted)
        .map((l) => this.mapListing(l, startupName, remoteConfigKind, input.descriptionFormat))
        .filter((p): p is JobPostDto => p !== null);

      this.logger.log(`Wellfound ATS: mapped ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(
        jobPosts,
        jobPosts.length ? undefined : new ScrapeDiagnostics('empty', 'no JobListing entries in board payload'),
      );
    } catch (err: any) {
      this.logger.error(`Wellfound ATS scrape failed: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * JobListingRemoteConfig ref → kind from one board page. The caller merges
   * each page into a per-scrape map consumed by mapListing.
   */
  private collectRemoteConfigKind(data: Record<string, any>): Record<string, string | undefined> {
    const kinds: Record<string, string | undefined> = {};
    for (const [key, entry] of Object.entries(data)) {
      if (entry?.__typename === 'JobListingRemoteConfig') {
        kinds[key] = (entry as WellfoundAtsRemoteConfig).kind;
      }
    }
    return kinds;
  }

  private resolveSlug(input: ScraperInputDto): string | null {
    if (input.companyUrl) {
      const match = input.companyUrl.match(/\/company(?:-l)?\/([^/?#]+)/);
      if (match) return match[1];
    }
    const slug = input.companySlug?.trim();
    return slug || null;
  }

  private boardUrl(slug: string, pageNum: number): string {
    const base = `https://${WELLFOUND_ATS_HOST}/company/${slug}/jobs`;
    return pageNum > 1 ? `${base}?page=${pageNum}` : base;
  }

  private mapListing(
    listing: WellfoundAtsJobListing,
    startupName: string | null,
    remoteConfigKind: Record<string, string | undefined>,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!listing.id || !listing.title) return null;

    const jobUrl = `https://${WELLFOUND_ATS_HOST}/jobs/${listing.id}${
      listing.slug ? `-${listing.slug}` : ''
    }`;

    let description: string | null = null;
    if (listing.descriptionSnippet) {
      if (format === DescriptionFormat.HTML) {
        description = listing.descriptionSnippet;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(listing.descriptionSnippet) ?? listing.descriptionSnippet;
      } else {
        description = htmlToPlainText(listing.descriptionSnippet);
      }
    }

    const locationParsed = parseLocationList(listing.locationNames ?? []);

    const remoteKind = listing.remoteConfig?.__ref
      ? remoteConfigKind[listing.remoteConfig.__ref]
      : undefined;
    const isRemote = Boolean(listing.remote) || /remote/i.test(remoteKind ?? '');

    const jobType = listing.jobType ? getJobTypeFromString(listing.jobType) : null;

    return new JobPostDto({
      id: `wellfound_ats-${listing.id}`,
      title: listing.title,
      companyName: startupName,
      jobUrl,
      location: locationParsed.location,
      ...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {}),
      description,
      compensation: this.parseCompensation(listing.compensation),
      datePosted: listing.liveStartAt ? toDateOnly(listing.liveStartAt * 1000) : null,
      isRemote: isRemote || locationParsed.remoteMentioned,
      department: listing.primaryRoleParent ?? listing.primaryRoleTitle ?? null,
      ...(jobType ? { jobType: [jobType] } : {}),
      employmentType: listing.jobType ?? null,
      emails: extractEmails(description),
      site: Site.WELLFOUND_ATS,
      atsId: String(listing.id),
      atsType: Site.WELLFOUND_ATS,
    });
  }

  /**
   * `"$120k – $200k"` (or `"$120k"`) → yearly CompensationDto. Wellfound emits
   * a pre-formatted string, so unparseable values degrade to null rather than
   * a wrong structured amount.
   */
  private parseCompensation(raw?: string | null): CompensationDto | null {
    if (!raw) return null;
    const m = raw.match(
      /([$€£])\s*([\d.]+)\s*k?\s*(?:[–—-]\s*([$€£]?)\s*([\d.]+)\s*k?)?/i,
    );
    if (!m) return null;
    const currency = { $: 'USD', '€': 'EUR', '£': 'GBP' }[m[1]] ?? 'USD';
    const scale = /k/i.test(raw) ? 1000 : 1;
    const min = Number(m[2]) * scale;
    const max = m[4] ? Number(m[4]) * scale : undefined;
    if (!Number.isFinite(min) || (m[4] && !Number.isFinite(max))) return null;
    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount: min,
      maxAmount: max,
      currency,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
