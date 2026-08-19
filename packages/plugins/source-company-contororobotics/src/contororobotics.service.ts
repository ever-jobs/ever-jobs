import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Contoro Robotics — Builds autonomous truck-unloading robots for supply chain warehouses.
 *
 * Contoro Robotics develops warehouse automation technology, including
 * autonomous truck-unloading systems capable of handling heavy boxes. The
 * company combines robotic hardware with remote human assistance for supply
 * chain operations. It is headquartered in Austin, Texas.
 *
 * Sector: Robotics / Warehouse automation. HQ: Austin, Texas, USA.
 *
 * Source: Ashby job board, company slug `contoro`
 * (`https://jobs.ashbyhq.com/contoro`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'contoro';
const COMPANY_NAME = 'Contoro Robotics';

@SourcePlugin({
  site: Site.CONTORO_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ContoroRoboticsService implements IScraper {
  private readonly logger = new Logger(ContoroRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Contoro Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Contoro Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONTORO_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'contororobotics-');
      }
    }

    this.logger.log(`Contoro Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
