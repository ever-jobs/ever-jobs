import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Dave — A consumer banking app offering banking and short-term cash advance products.
 *
 * Dave is a consumer fintech offering banking services and short-term cash
 * advance products designed for accessibility and affordability. It operates
 * a mobile banking app for everyday consumers.
 *
 * Sector: Fintech - Neobanking & consumer credit. HQ: Los Angeles, California, USA.
 *
 * Source: Ashby job board, company slug `dave`
 * (`https://jobs.ashbyhq.com/dave`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'dave';
const COMPANY_NAME = 'Dave';

@SourcePlugin({
  site: Site.DAVE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DaveService implements IScraper {
  private readonly logger = new Logger(DaveService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Dave',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Dave: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DAVE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'dave-');
      }
    }

    this.logger.log(`Dave: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
