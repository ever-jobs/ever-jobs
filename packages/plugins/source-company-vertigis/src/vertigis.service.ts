import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * VertiGIS — Software solutions for geographic information systems (GIS).
 *
 * VertiGIS develops software for geographic information systems, serving
 * sectors including energy supply, water management, land management,
 * government, infrastructure, facility management, and telecommunications.
 *
 * Sector: GIS software. HQ: Germany (Cologne / Aalen).
 *
 * Source: Recruitee careers board, subdomain `vertigis`
 * (`https://vertigis.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'vertigis';
const COMPANY_NAME = 'VertiGIS';

@SourcePlugin({
  site: Site.VERTIGIS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VertiGISService implements IScraper {
  private readonly logger = new Logger(VertiGISService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape VertiGIS',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `VertiGIS: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VERTIGIS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'vertigis-');
      }
    }

    this.logger.log(`VertiGIS: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
