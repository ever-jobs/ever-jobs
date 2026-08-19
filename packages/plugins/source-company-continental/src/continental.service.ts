import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Continental — Automotive supplier and tire manufacturer producing tires, brake systems, and vehicle electronics.
 *
 * Continental AG is a German automotive parts manufacturing company. It
 * develops technologies and services for mobility, including tires, brake
 * systems, vehicle electronics, and industrial products. It supplies
 * automotive OEMs and operates plants globally.
 *
 * Sector: Automotive supplier / Tire manufacturing. HQ: Hanover, Lower Saxony, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `Continental`
 * (`https://jobs.smartrecruiters.com/Continental`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Continental';
const COMPANY_NAME = 'Continental';

@SourcePlugin({
  site: Site.CONTINENTAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ContinentalService implements IScraper {
  private readonly logger = new Logger(ContinentalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Continental',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Continental: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONTINENTAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'continental-');
      }
    }

    this.logger.log(`Continental: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
