import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Dealroom.co — Data platform providing intelligence on startups, scaleups, investors, and tech ecosystems.
 *
 * Dealroom.co is an Amsterdam-based B2B data platform providing intelligence
 * on startups, scaleups, investors, and innovation ecosystems, used by
 * governments, corporates, and investors. It hires business development and
 * client relationship roles across EMEA and North America.
 *
 * Sector: Data / market intelligence SaaS. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `dealroomco`
 * (`https://dealroomco.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'dealroomco';
const COMPANY_NAME = 'Dealroom.co';

@SourcePlugin({
  site: Site.DEALROOM_CO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DealroomCoService implements IScraper {
  private readonly logger = new Logger(DealroomCoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Dealroom.co',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Dealroom.co: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEALROOM_CO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'dealroomco-');
      }
    }

    this.logger.log(`Dealroom.co: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
