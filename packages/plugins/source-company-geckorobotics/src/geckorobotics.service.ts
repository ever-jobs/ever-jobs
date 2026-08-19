import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gecko Robotics — Builds wall-climbing inspection robots and software for critical infrastructure.
 *
 * Gecko Robotics builds wall-climbing robots and AI software to inspect and
 * assess the health of critical physical infrastructure such as power
 * plants, ships, and industrial facilities. Its Cantilever operating
 * platform aggregates inspection data. The company is headquartered in
 * Pittsburgh, Pennsylvania.
 *
 * Sector: Robotics / Industrial inspection. HQ: Pittsburgh, Pennsylvania, USA.
 *
 * Source: Ashby job board, company slug `gecko-robotics`
 * (`https://jobs.ashbyhq.com/gecko-robotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gecko-robotics';
const COMPANY_NAME = 'Gecko Robotics';

@SourcePlugin({
  site: Site.GECKO_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GeckoRoboticsService implements IScraper {
  private readonly logger = new Logger(GeckoRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Gecko Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gecko Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GECKO_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'geckorobotics-');
      }
    }

    this.logger.log(`Gecko Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
