import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * constellr — Thermal-satellite constellation providing land-surface-temperature data.
 *
 * constellr GmbH develops a thermal satellite constellation to deliver
 * land-surface-temperature data for climate, agriculture, and security
 * applications, serving commercial, governmental, and defense customers.
 *
 * Sector: Space / Earth-observation data. HQ: Freiburg, Germany.
 *
 * Source: Recruitee careers board, subdomain `constellr`
 * (`https://constellr.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'constellr';
const COMPANY_NAME = 'constellr';

@SourcePlugin({
  site: Site.CONSTELLR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ConstellrService implements IScraper {
  private readonly logger = new Logger(ConstellrService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape constellr',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `constellr: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONSTELLR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'constellr-');
      }
    }

    this.logger.log(`constellr: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
