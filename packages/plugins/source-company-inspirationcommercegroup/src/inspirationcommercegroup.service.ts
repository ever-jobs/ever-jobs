import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Inspiration Commerce Group — Operator of a portfolio of e-commerce and consumer brands.
 *
 * Inspiration Commerce Group operates a portfolio of e-commerce and consumer
 * businesses. Its open roles span e-commerce operations, personal shopping,
 * sales, and finance. The company hosts its careers page on Ashby.
 *
 * Sector: E-commerce / consumer brands. HQ: United States.
 *
 * Source: Ashby job board, company slug `inspiration-commerce-group`
 * (`https://jobs.ashbyhq.com/inspiration-commerce-group`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'inspiration-commerce-group';
const COMPANY_NAME = 'Inspiration Commerce Group';

@SourcePlugin({
  site: Site.INSPIRATION_COMMERCE_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InspirationCommerceGroupService implements IScraper {
  private readonly logger = new Logger(InspirationCommerceGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Inspiration Commerce Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Inspiration Commerce Group: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INSPIRATION_COMMERCE_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'inspirationcommercegroup-');
      }
    }

    this.logger.log(`Inspiration Commerce Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
