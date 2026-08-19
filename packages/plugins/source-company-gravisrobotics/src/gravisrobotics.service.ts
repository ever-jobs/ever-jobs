import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gravis Robotics — Autonomous control systems for construction and earth-moving machinery.
 *
 * Gravis Robotics develops autonomy and mapping software to automate heavy
 * construction machines such as excavators for tasks like autonomous
 * excavation and earth-moving.
 *
 * Sector: Robotics. HQ: Zurich, Zurich, Switzerland.
 *
 * Source: Lever job board, company slug `gravisrobotics`
 * (`https://jobs.lever.co/gravisrobotics`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gravisrobotics';
const COMPANY_NAME = 'Gravis Robotics';

@SourcePlugin({
  site: Site.GRAVIS_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GravisRoboticsService implements IScraper {
  private readonly logger = new Logger(GravisRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Gravis Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gravis Robotics: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GRAVIS_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'gravisrobotics-');
      }
    }

    this.logger.log(`Gravis Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
