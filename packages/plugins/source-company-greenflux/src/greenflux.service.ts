import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * GreenFlux — Cloud SaaS platform for managing EV charging networks and smart-charging operations.
 *
 * GreenFlux is an Amsterdam-based provider of a cloud platform for managing
 * electric-vehicle charging infrastructure, including charge-point
 * management, smart charging and roaming. The Recruitee board
 * greenflux.recruitee.com returned 5 live offers, all Amsterdam-based
 * (product management, finance, customer success and solutions roles).
 *
 * Sector: EV-charging SaaS (retail-tech adjacent). HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `greenflux`
 * (`https://greenflux.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'greenflux';
const COMPANY_NAME = 'GreenFlux';

@SourcePlugin({
  site: Site.GREENFLUX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GreenFluxService implements IScraper {
  private readonly logger = new Logger(GreenFluxService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape GreenFlux',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `GreenFlux: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GREENFLUX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'greenflux-');
      }
    }

    this.logger.log(`GreenFlux: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
