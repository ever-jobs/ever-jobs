import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Finix — Payment processing infrastructure that lets software companies process and manage payments in-house.
 *
 * Finix provides payment processing infrastructure and a full-stack platform
 * enabling software companies and businesses to accept, manage, and monetize
 * payments. It offers APIs and tools for onboarding, processing, and
 * payouts.
 *
 * Sector: Payments. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `finix`
 * (`https://jobs.lever.co/finix`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'finix';
const COMPANY_NAME = 'Finix';

@SourcePlugin({
  site: Site.FINIX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FinixService implements IScraper {
  private readonly logger = new Logger(FinixService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Finix',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Finix: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FINIX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'finix-');
      }
    }

    this.logger.log(`Finix: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
