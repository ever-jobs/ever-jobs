import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HEMERIA — Aerospace and defense company building nanosatellites, stratospheric balloons and radar systems.
 *
 * HEMERIA is a French aerospace and defense company that designs, produces
 * and supplies advanced space systems and vehicles, including
 * nanosatellites, stratospheric balloons and radar systems, for commercial,
 * institutional and scientific customers. Careers are hosted on Recruitee at
 * hemeriagroup.recruitee.com.
 *
 * Sector: Aerospace / Defense / Deep tech. HQ: France.
 *
 * Source: Recruitee careers board, subdomain `hemeriagroup`
 * (`https://hemeriagroup.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'hemeriagroup';
const COMPANY_NAME = 'HEMERIA';

@SourcePlugin({
  site: Site.HEMERIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HEMERIAService implements IScraper {
  private readonly logger = new Logger(HEMERIAService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape HEMERIA',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `HEMERIA: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HEMERIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'hemeria-');
      }
    }

    this.logger.log(`HEMERIA: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
