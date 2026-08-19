import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SE3 Labs — Builds GPS-denied spatial-AI navigation software for autonomous drone swarms.
 *
 * SE3 Labs is a Munich-based spatial AI company providing GPS-denied
 * autonomous navigation and shared 3D situational awareness for aerial and
 * ground drone swarms. Its on-edge software combines visual-inertial
 * odometry, real-time 3D perception, and natural-language command. The
 * company was founded in 2023 by researchers from the Technical University
 * of Munich and has German Bundeswehr contracts.
 *
 * Sector: Defense (Spatial AI / Drones). HQ: Munich, Germany.
 *
 * Source: Ashby job board, company slug `se3`
 * (`https://jobs.ashbyhq.com/se3`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'se3';
const COMPANY_NAME = 'SE3 Labs';

@SourcePlugin({
  site: Site.SE3_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SE3LabsService implements IScraper {
  private readonly logger = new Logger(SE3LabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape SE3 Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `SE3 Labs: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SE3_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'se3labs-');
      }
    }

    this.logger.log(`SE3 Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
