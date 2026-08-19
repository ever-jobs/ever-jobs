import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Weeztix — Event-ticketing SaaS platform selling and managing tickets for events and festivals.
 *
 * Weeztix is a Dutch ticketing technology company operating an online
 * ticket-sales and event-management platform used by event and festival
 * organisers. It has offices in Eindhoven and Amsterdam. The Recruitee board
 * weeztix.recruitee.com returned 7 live offers spanning sales, customer
 * success, back-end engineering and support.
 *
 * Sector: Ticketing / events SaaS (retail-tech). HQ: Eindhoven / Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `weeztix`
 * (`https://weeztix.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'weeztix';
const COMPANY_NAME = 'Weeztix';

@SourcePlugin({
  site: Site.WEEZTIX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WeeztixService implements IScraper {
  private readonly logger = new Logger(WeeztixService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Weeztix',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Weeztix: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WEEZTIX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'weeztix-');
      }
    }

    this.logger.log(`Weeztix: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
