import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Tapcart — Mobile commerce platform that builds native shopping apps for Shopify brands.
 *
 * Tapcart is a mobile commerce platform that lets Shopify brands build and
 * manage native iOS and Android shopping apps without engineering resources.
 * Its platform powers push notifications, content, and the mobile storefront
 * experience. The company is based in Santa Monica.
 *
 * Sector: E-commerce tech / mobile commerce. HQ: Santa Monica, California, United States.
 *
 * Source: Ashby job board, company slug `tapcart`
 * (`https://jobs.ashbyhq.com/tapcart`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tapcart';
const COMPANY_NAME = 'Tapcart';

@SourcePlugin({
  site: Site.TAPCART,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TapcartService implements IScraper {
  private readonly logger = new Logger(TapcartService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Tapcart',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Tapcart: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TAPCART;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'tapcart-');
      }
    }

    this.logger.log(`Tapcart: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
