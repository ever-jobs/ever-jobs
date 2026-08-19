import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Spreetail — E-commerce accelerator that grows brands\' market share across online marketplaces.
 *
 * Spreetail is an e-commerce company that partners with brands to sell and
 * fulfill products across marketplaces such as Amazon, Walmart, Target, and
 * TikTok Shop. It operates fulfillment, inventory, and transportation
 * operations across the US, Europe, and the Philippines.
 *
 * Sector: E-commerce. HQ: Lincoln, Nebraska, USA.
 *
 * Source: Lever job board, company slug `spreetail`
 * (`https://jobs.lever.co/spreetail`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'spreetail';
const COMPANY_NAME = 'Spreetail';

@SourcePlugin({
  site: Site.SPREETAIL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpreetailService implements IScraper {
  private readonly logger = new Logger(SpreetailService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Spreetail',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Spreetail: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPREETAIL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'spreetail-');
      }
    }

    this.logger.log(`Spreetail: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
