import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Humble — Autonomy software for self-driving trucks.
 *
 * Humble develops autonomy software systems that enable trucks to drive
 * autonomously, working across perception, controls, and calibration for
 * self-driving heavy vehicles.
 *
 * Sector: Autonomous Vehicles. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `humble-robotics`
 * (`https://jobs.lever.co/humble-robotics`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'humble-robotics';
const COMPANY_NAME = 'Humble';

@SourcePlugin({
  site: Site.HUMBLE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HumbleService implements IScraper {
  private readonly logger = new Logger(HumbleService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Humble',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Humble: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HUMBLE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'humblerobotics-');
      }
    }

    this.logger.log(`Humble: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
