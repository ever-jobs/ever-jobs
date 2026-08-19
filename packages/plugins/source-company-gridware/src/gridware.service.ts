import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gridware — Grid-monitoring company using pole-mounted sensors to detect electrical grid faults before they cause outages or wildfires.
 *
 * Gridware builds a hardware and software platform it calls Active Grid
 * Response, using high-precision sensors on utility poles to detect grid
 * disturbances early and enable proactive maintenance and fault mitigation
 * for electric utilities.
 *
 * Sector: Climate tech / Grid resilience. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `gridware`
 * (`https://jobs.lever.co/gridware`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gridware';
const COMPANY_NAME = 'Gridware';

@SourcePlugin({
  site: Site.GRIDWARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GridwareService implements IScraper {
  private readonly logger = new Logger(GridwareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Gridware',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gridware: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GRIDWARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'gridware-');
      }
    }

    this.logger.log(`Gridware: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
