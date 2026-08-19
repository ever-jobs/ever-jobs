import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * DroneDeploy — Reality-capture platform combining drones, robotics, and AI for field teams.
 *
 * DroneDeploy provides a reality-capture and analytics platform that uses
 * drones and ground robots to map and inspect physical sites across
 * construction, energy, and agriculture.
 *
 * Sector: Hardware/Drones. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `dronedeploy`
 * (`https://jobs.lever.co/dronedeploy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'dronedeploy';
const COMPANY_NAME = 'DroneDeploy';

@SourcePlugin({
  site: Site.DRONEDEPLOY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DroneDeployService implements IScraper {
  private readonly logger = new Logger(DroneDeployService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape DroneDeploy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `DroneDeploy: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DRONEDEPLOY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'dronedeploy-');
      }
    }

    this.logger.log(`DroneDeploy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
