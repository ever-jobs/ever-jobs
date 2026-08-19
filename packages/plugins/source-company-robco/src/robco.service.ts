import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * RobCo — Builds modular industrial robotic systems combined with physical AI software.
 *
 * RobCo develops modular industrial robotic systems paired with software to
 * automate manufacturing processes. The company combines reconfigurable
 * hardware modules with physical AI. It is headquartered in Munich, Germany,
 * with locations in San Francisco and Austin.
 *
 * Sector: Industrial automation / Robotics. HQ: Munich, Germany.
 *
 * Source: Ashby job board, company slug `robco`
 * (`https://jobs.ashbyhq.com/robco`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'robco';
const COMPANY_NAME = 'RobCo';

@SourcePlugin({
  site: Site.ROBCO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RobCoService implements IScraper {
  private readonly logger = new Logger(RobCoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape RobCo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `RobCo: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ROBCO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'robco-');
      }
    }

    this.logger.log(`RobCo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
