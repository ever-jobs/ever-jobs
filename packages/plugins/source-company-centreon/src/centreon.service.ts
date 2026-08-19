import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Centreon — IT infrastructure monitoring and observability software vendor.
 *
 * Centreon is a French software editor providing IT infrastructure
 * monitoring and observability solutions, with a platform of connectors and
 * tools for supervising software and hardware systems. It is positioned as a
 * European leader in IT monitoring. Careers are hosted on Recruitee at
 * centreon.recruitee.com.
 *
 * Sector: IT monitoring / Software editor. HQ: Paris, France.
 *
 * Source: Recruitee careers board, subdomain `centreon`
 * (`https://centreon.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'centreon';
const COMPANY_NAME = 'Centreon';

@SourcePlugin({
  site: Site.CENTREON,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CentreonService implements IScraper {
  private readonly logger = new Logger(CentreonService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Centreon',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Centreon: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CENTREON;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'centreon-');
      }
    }

    this.logger.log(`Centreon: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
