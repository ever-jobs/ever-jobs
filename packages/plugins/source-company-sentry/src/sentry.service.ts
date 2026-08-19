import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sentry — Developer-first error tracking and application performance monitoring platform.
 *
 * Sentry develops an application monitoring and observability platform that
 * helps developers detect, trace, and fix errors and performance issues. Its
 * core error-tracking software is open source and used by developers and
 * organizations worldwide.
 *
 * Sector: Observability / Developer tools. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `sentry`
 * (`https://jobs.ashbyhq.com/sentry`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sentry';
const COMPANY_NAME = 'Sentry';

@SourcePlugin({
  site: Site.SENTRY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SentryService implements IScraper {
  private readonly logger = new Logger(SentryService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Sentry',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sentry: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SENTRY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sentry-');
      }
    }

    this.logger.log(`Sentry: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
