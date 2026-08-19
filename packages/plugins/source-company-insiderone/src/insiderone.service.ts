import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Insider — AI-native customer engagement and marketing platform for enterprises.
 *
 * Insider provides a customer data and cross-channel marketing engagement
 * platform that unifies data and personalizes experiences across web, app,
 * and messaging. It sells to enterprise marketing teams worldwide.
 *
 * Sector: B2B SaaS / Marketing Technology. HQ: Istanbul, Istanbul, Turkey.
 *
 * Source: Lever job board, company slug `insiderone`
 * (`https://jobs.lever.co/insiderone`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'insiderone';
const COMPANY_NAME = 'Insider';

@SourcePlugin({
  site: Site.INSIDER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InsiderService implements IScraper {
  private readonly logger = new Logger(InsiderService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Insider',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Insider: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INSIDER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'insiderone-');
      }
    }

    this.logger.log(`Insider: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
