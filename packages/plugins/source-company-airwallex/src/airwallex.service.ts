import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Airwallex — A global payments and financial platform for businesses.
 *
 * Airwallex is a global financial platform offering cross-border payments,
 * multi-currency accounts, cards, and treasury and payments infrastructure
 * for businesses. It serves companies operating internationally.
 *
 * Sector: Fintech - Cross-border payments. HQ: Singapore / Melbourne, Australia.
 *
 * Source: Ashby job board, company slug `airwallex`
 * (`https://jobs.ashbyhq.com/airwallex`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'airwallex';
const COMPANY_NAME = 'Airwallex';

@SourcePlugin({
  site: Site.AIRWALLEX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AirwallexService implements IScraper {
  private readonly logger = new Logger(AirwallexService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Airwallex',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Airwallex: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AIRWALLEX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'airwallex-');
      }
    }

    this.logger.log(`Airwallex: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
