import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Trendyol — E-commerce marketplace operating across Turkey, the Middle East, and Europe.
 *
 * Trendyol is an e-commerce marketplace operating across Turkey, the Gulf,
 * and Europe, delivering millions of parcels daily. It runs marketplace,
 * logistics, and category-management operations across multiple countries.
 *
 * Sector: Marketplaces / E-commerce. HQ: Istanbul, Turkey.
 *
 * Source: Lever job board, company slug `trendyol`
 * (`https://jobs.lever.co/trendyol`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'trendyol';
const COMPANY_NAME = 'Trendyol';

@SourcePlugin({
  site: Site.TRENDYOL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TrendyolService implements IScraper {
  private readonly logger = new Logger(TrendyolService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Trendyol',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Trendyol: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRENDYOL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'trendyol-');
      }
    }

    this.logger.log(`Trendyol: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
