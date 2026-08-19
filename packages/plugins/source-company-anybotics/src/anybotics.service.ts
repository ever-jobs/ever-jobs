import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ANYbotics — Builds autonomous legged inspection robots with AI/ML perception.
 *
 * ANYbotics builds the ANYmal legged mobile robot for autonomous industrial
 * inspection, using camera- and LIDAR-based sensing and AI/ML perception for
 * full autonomy in energy, process and utility plants.
 *
 * Sector: Applied AI / robotics. HQ: Zurich, Zurich, Switzerland.
 *
 * Source: Lever job board, company slug `anybotics`
 * (`https://jobs.lever.co/anybotics`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'anybotics';
const COMPANY_NAME = 'ANYbotics';

@SourcePlugin({
  site: Site.ANYBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ANYboticsService implements IScraper {
  private readonly logger = new Logger(ANYboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape ANYbotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `ANYbotics: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ANYBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'anybotics-');
      }
    }

    this.logger.log(`ANYbotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
