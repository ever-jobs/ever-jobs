import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Foundry Robotics — Builds AI-powered robotic manufacturing systems for robotics and hardware production.
 *
 * Foundry Robotics builds AI-powered manufacturing systems, robots, factory
 * software, and data infrastructure aimed at contract manufacturing of
 * robotics and hardware. The company positions itself as an AI-first,
 * assembly-focused, dual-use manufacturer. Roles are based on-site in San
 * Francisco, California.
 *
 * Sector: Robotics / Manufacturing automation. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `foundry-robotics`
 * (`https://jobs.ashbyhq.com/foundry-robotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'foundry-robotics';
const COMPANY_NAME = 'Foundry Robotics';

@SourcePlugin({
  site: Site.FOUNDRY_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FoundryRoboticsService implements IScraper {
  private readonly logger = new Logger(FoundryRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Foundry Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Foundry Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FOUNDRY_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'foundryrobotics-');
      }
    }

    this.logger.log(`Foundry Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
