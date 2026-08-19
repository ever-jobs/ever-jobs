import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Red Canyon Engineering & Software — Aerospace engineering and flight software services for space missions.
 *
 * Red Canyon provides engineering and flight software services for
 * spacecraft and space missions, supporting navigation, flight software, and
 * systems engineering for aerospace programs.
 *
 * Sector: Space/Aerospace. HQ: Denver, Colorado, United States.
 *
 * Source: Lever job board, company slug `redcanyonsoftware`
 * (`https://jobs.lever.co/redcanyonsoftware`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'redcanyonsoftware';
const COMPANY_NAME = 'Red Canyon Engineering & Software';

@SourcePlugin({
  site: Site.RED_CANYON_ENGINEERING_SOFTWARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RedCanyonEngineeringSoftwareService implements IScraper {
  private readonly logger = new Logger(RedCanyonEngineeringSoftwareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Red Canyon Engineering & Software',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Red Canyon Engineering & Software: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RED_CANYON_ENGINEERING_SOFTWARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'redcanyonsoftware-');
      }
    }

    this.logger.log(`Red Canyon Engineering & Software: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
