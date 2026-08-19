import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Trustly — Open Banking payments network enabling account-to-account (Pay by Bank) transactions.
 *
 * Trustly operates an Open Banking payments network that connects merchants
 * directly to consumers' bank accounts, enabling account-to-account payments
 * at checkout as an alternative to card rails.
 *
 * Sector: Payments / Open Banking. HQ: Stockholm, Stockholm County, Sweden.
 *
 * Source: Lever job board, company slug `trustly`
 * (`https://jobs.lever.co/trustly`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'trustly';
const COMPANY_NAME = 'Trustly';

@SourcePlugin({
  site: Site.TRUSTLY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TrustlyService implements IScraper {
  private readonly logger = new Logger(TrustlyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Trustly',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Trustly: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRUSTLY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'trustly-');
      }
    }

    this.logger.log(`Trustly: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
