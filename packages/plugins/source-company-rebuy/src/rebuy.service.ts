import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Rebuy — Personalization and merchandising platform for Shopify e-commerce brands.
 *
 * Rebuy provides a personalization and intelligent merchandising platform
 * for direct-to-consumer brands, with a focus on the Shopify ecosystem. Its
 * tools power product recommendations, upsells, and personalized shopping
 * experiences. The company hosts its careers page on Ashby.
 *
 * Sector: E-commerce tech / personalization. HQ: Steamboat Springs, Colorado, United States.
 *
 * Source: Ashby job board, company slug `rebuy`
 * (`https://jobs.ashbyhq.com/rebuy`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'rebuy';
const COMPANY_NAME = 'Rebuy';

@SourcePlugin({
  site: Site.REBUY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RebuyService implements IScraper {
  private readonly logger = new Logger(RebuyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Rebuy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Rebuy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REBUY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'rebuy-');
      }
    }

    this.logger.log(`Rebuy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
