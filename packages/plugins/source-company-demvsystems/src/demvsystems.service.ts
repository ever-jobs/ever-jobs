import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * DEMV Systems — Broker-management software for the insurance and financial-advisory sector.
 *
 * DEMV Systems GmbH develops software for the insurance and
 * financial-advisory sector; its main product is a broker-management system
 * that digitizes administrative and advisory processes. It is headquartered
 * in Hamburg.
 *
 * Sector: Insurtech software. HQ: Hamburg, Germany.
 *
 * Source: Recruitee careers board, subdomain `demvsystems`
 * (`https://demvsystems.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'demvsystems';
const COMPANY_NAME = 'DEMV Systems';

@SourcePlugin({
  site: Site.DEMV_SYSTEMS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DEMVSystemsService implements IScraper {
  private readonly logger = new Logger(DEMVSystemsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape DEMV Systems',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `DEMV Systems: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEMV_SYSTEMS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'demvsystems-');
      }
    }

    this.logger.log(`DEMV Systems: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
