import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Reliable Robotics — Develops automated flight systems for remotely operated aircraft.
 *
 * Reliable Robotics develops automation systems to enable continuously
 * monitored, remotely operated aircraft. The company builds an aircraft
 * automation platform aimed at cargo and other aviation operations and works
 * with regulators on certification. It is headquartered in Mountain View,
 * California.
 *
 * Sector: Autonomy / Aviation. HQ: Mountain View, California, USA.
 *
 * Source: Ashby job board, company slug `reliable-robotics`
 * (`https://jobs.ashbyhq.com/reliable-robotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'reliable-robotics';
const COMPANY_NAME = 'Reliable Robotics';

@SourcePlugin({
  site: Site.RELIABLE_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ReliableRoboticsService implements IScraper {
  private readonly logger = new Logger(ReliableRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Reliable Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Reliable Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RELIABLE_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'reliablerobotics-');
      }
    }

    this.logger.log(`Reliable Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
