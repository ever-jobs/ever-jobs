import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * gridscale — Cloud infrastructure platform provider (part of OVHcloud).
 *
 * gridscale GmbH provides cloud infrastructure services and builds an
 * OpenStack-based on-premise cloud platform. Based in Cologne, it is part of
 * OVHcloud and emphasizes sustainable cloud infrastructure.
 *
 * Sector: Cloud infrastructure / IaaS. HQ: Cologne, Germany.
 *
 * Source: Recruitee careers board, subdomain `gridscale`
 * (`https://gridscale.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'gridscale';
const COMPANY_NAME = 'gridscale';

@SourcePlugin({
  site: Site.GRIDSCALE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GridscaleService implements IScraper {
  private readonly logger = new Logger(GridscaleService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape gridscale',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `gridscale: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GRIDSCALE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'gridscale-');
      }
    }

    this.logger.log(`gridscale: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
