import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Natuvion — Software and services for migrating business-critical data and processes between platforms.
 *
 * Natuvion GmbH describes itself as a digital moving company that transports
 * business-critical data and processes between technology platforms,
 * focusing on SAP data migration, transformation, integration, security, and
 * quality assurance.
 *
 * Sector: Enterprise software / SAP services. HQ: Walldorf, Germany.
 *
 * Source: Recruitee careers board, subdomain `natuvion`
 * (`https://natuvion.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'natuvion';
const COMPANY_NAME = 'Natuvion';

@SourcePlugin({
  site: Site.NATUVION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NatuvionService implements IScraper {
  private readonly logger = new Logger(NatuvionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Natuvion',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Natuvion: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NATUVION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'natuvion-');
      }
    }

    this.logger.log(`Natuvion: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
