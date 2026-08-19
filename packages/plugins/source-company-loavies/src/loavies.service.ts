import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * LOAVIES — Direct-to-consumer online fashion brand with frequent new-product drops selling across European markets.
 *
 * LOAVIES is a Dutch direct-to-consumer online fashion brand (founded 2012)
 * that releases frequent new collections and sells across several European
 * markets, per its careers copy citing over one million active customers.
 * Its HQ is in Zwolle, with retail activity in Utrecht. The Recruitee board
 * loavies.recruitee.com returned 10 live offers spanning merchandising,
 * social/content, retail, customer service, styling and influencer
 * marketing.
 *
 * Sector: E-commerce retail (D2C fashion). HQ: Zwolle, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `loavies`
 * (`https://loavies.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'loavies';
const COMPANY_NAME = 'LOAVIES';

@SourcePlugin({
  site: Site.LOAVIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LOAVIESService implements IScraper {
  private readonly logger = new Logger(LOAVIESService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape LOAVIES',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `LOAVIES: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LOAVIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'loavies-');
      }
    }

    this.logger.log(`LOAVIES: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
