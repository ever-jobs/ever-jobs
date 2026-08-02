import { SourcePlugin } from '@ever-jobs/plugin';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  randomSleep,
  BrowserPool,
  toDateOnly,
} from '@ever-jobs/common';
import { WELLFOUND_JOBS_URL, WELLFOUND_DELAY_MIN, WELLFOUND_DELAY_MAX } from './wellfound.constants';
import { WellfoundNextData, WellfoundListing } from './wellfound.types';

@SourcePlugin({
  site: Site.WELLFOUND,
  name: 'Wellfound',
  category: 'niche',
})
@Injectable()
export class WellfoundService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(WellfoundService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const proxy = input.proxies?.[0] ?? undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    let page;

    try {
      page = await BrowserPool.getPage({ proxy });
      const timeoutMs = (input.requestTimeout ?? 30) * 1000;

      const url = new URL(WELLFOUND_JOBS_URL);
      if (input.searchTerm) url.searchParams.set('q', input.searchTerm);

      this.logger.log(`Wellfound: navigating to ${url.toString()}`);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Wait for Next.js hydration
      await this.delay(6000);

      // Extract __NEXT_DATA__ from the page
      const nextDataJson = await page.evaluate(
        `(() => { const s = document.getElementById('__NEXT_DATA__'); return s ? s.textContent : null; })()`,
      ) as string | null;

      if (!nextDataJson) {
        // TODO: Try alternative extraction (Apollo state, direct DOM parsing)
        this.logger.warn('Wellfound: __NEXT_DATA__ not found — page structure may have changed');
        return new JobResponseDto([]);
      }

      let nextData: WellfoundNextData;
      try {
        nextData = JSON.parse(nextDataJson);
      } catch {
        this.logger.error('Wellfound: failed to parse __NEXT_DATA__ JSON');
        return new JobResponseDto([]);
      }

      // TODO: Validate the exact path to job listings in __NEXT_DATA__
      // Wellfound may nest listings under different keys depending on the page
      const listings = this.extractListings(nextData);

      if (listings.length === 0) {
        this.logger.warn(
          'Wellfound: zero listings found in __NEXT_DATA__ — data structure may have changed',
        );
      }

      this.logger.log(`Wellfound: found ${listings.length} listings`);

      const jobPosts: JobPostDto[] = [];
      for (const listing of listings) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.mapListing(listing, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.debug(`Wellfound: failed to map listing: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Wellfound scrape failed: ${err.message}`);
      return new JobResponseDto([]);
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * Recursively search __NEXT_DATA__ for arrays that look like job listings.
   * TODO: Pin down exact path after validating against live site.
   */
  private extractListings(data: WellfoundNextData): WellfoundListing[] {
    // Try common paths
    const pageProps = data.props?.pageProps;
    if (pageProps?.listings && Array.isArray(pageProps.listings)) {
      return pageProps.listings;
    }
    if (pageProps?.jobs && Array.isArray(pageProps.jobs)) {
      return pageProps.jobs;
    }

    // Deep search: look for arrays of objects with 'title' and 'company' fields
    const found = this.findListingsDeep(data, 3);
    return found;
  }

  private findListingsDeep(obj: unknown, maxDepth: number): WellfoundListing[] {
    if (maxDepth <= 0 || !obj || typeof obj !== 'object') return [];

    if (Array.isArray(obj)) {
      // Check if this array looks like job listings
      const sample = obj[0];
      if (
        sample &&
        typeof sample === 'object' &&
        'title' in sample &&
        ('company' in sample || 'companyName' in sample)
      ) {
        return obj as WellfoundListing[];
      }
      return [];
    }

    for (const value of Object.values(obj)) {
      const result = this.findListingsDeep(value, maxDepth - 1);
      if (result.length > 0) return result;
    }

    return [];
  }

  private mapListing(
    listing: WellfoundListing,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!listing.title) return null;

    const id = `wellfound-${listing.id}`;
    const companyName = listing.company?.name ?? null;
    const companySlug = listing.company?.slug ?? '';
    const jobSlug = listing.slug ?? String(listing.id);
    const jobUrl = `https://wellfound.com/jobs/${jobSlug}`;

    let description: string | null = null;
    if (listing.description) {
      if (format === DescriptionFormat.HTML) {
        description = listing.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(listing.description) ?? listing.description;
      } else {
        description = htmlToPlainText(listing.description);
      }
    }

    const locationStr = listing.locations?.[0] ?? null;
    const location = locationStr ? new LocationDto({ city: locationStr }) : null;

    let compensation: CompensationDto | null = null;
    if (listing.compensation?.min != null || listing.compensation?.max != null) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: listing.compensation.min ?? undefined,
        maxAmount: listing.compensation.max ?? undefined,
        currency: listing.compensation.currency ?? 'USD',
      });
    }

    const datePosted = listing.createdAt
      ? toDateOnly(listing.createdAt)
      : null;

    return new JobPostDto({
      id,
      title: listing.title,
      companyName,
      companyLogo: listing.company?.logoUrl ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: listing.remote ?? false,
      emails: extractEmails(description),
      site: Site.WELLFOUND,
      skills: listing.skills?.length ? listing.skills : null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
