import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Serve Robotics — Builds autonomous sidewalk delivery robots for last-mile logistics.
 *
 * Serve Robotics designs and operates autonomous sidewalk delivery robots
 * for last-mile delivery in cities. The company builds the robots' hardware
 * and autonomy stack and operates a fleet for food and goods delivery. It is
 * publicly traded and headquartered in the San Francisco Bay Area.
 *
 * Sector: Robotics / Autonomous delivery. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `serverobotics`
 * (`https://jobs.ashbyhq.com/serverobotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'serverobotics';
const COMPANY_NAME = 'Serve Robotics';

@SourcePlugin({
  site: Site.SERVE_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ServeRoboticsService implements IScraper {
  private readonly logger = new Logger(ServeRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Serve Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Serve Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SERVE_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'serverobotics-');
      }
    }

    this.logger.log(`Serve Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
