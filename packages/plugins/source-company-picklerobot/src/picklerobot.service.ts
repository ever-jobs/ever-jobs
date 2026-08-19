import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pickle Robot Company — Autonomous robots that unload trucks and containers in warehouses and distribution centers.
 *
 * Pickle Robot builds physical AI systems that automate truck and container
 * unloading in logistics operations. Its robots use perception and autonomy
 * software to handle mixed-case freight.
 *
 * Sector: Robotics. HQ: Charlestown, Massachusetts, United States.
 *
 * Source: Lever job board, company slug `picklerobot`
 * (`https://jobs.lever.co/picklerobot`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'picklerobot';
const COMPANY_NAME = 'Pickle Robot Company';

@SourcePlugin({
  site: Site.PICKLE_ROBOT_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PickleRobotCompanyService implements IScraper {
  private readonly logger = new Logger(PickleRobotCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Pickle Robot Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pickle Robot Company: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PICKLE_ROBOT_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'picklerobot-');
      }
    }

    this.logger.log(`Pickle Robot Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
