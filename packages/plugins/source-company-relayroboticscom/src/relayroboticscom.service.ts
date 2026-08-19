import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Relay Robotics — Autonomous service robots for hotels, hospitals, and multi-tenant buildings.
 *
 * Relay Robotics builds autonomous mobile robots that make deliveries in
 * indoor commercial environments such as hotels and residential buildings,
 * navigating elevators and hallways without human assistance.
 *
 * Sector: Robotics. HQ: Campbell, California, United States.
 *
 * Source: Lever job board, company slug `relayrobotics.com`
 * (`https://jobs.lever.co/relayrobotics.com`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'relayrobotics.com';
const COMPANY_NAME = 'Relay Robotics';

@SourcePlugin({
  site: Site.RELAY_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RelayRoboticsService implements IScraper {
  private readonly logger = new Logger(RelayRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Relay Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Relay Robotics: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RELAY_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'relayroboticscom-');
      }
    }

    this.logger.log(`Relay Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
