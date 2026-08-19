import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pilot Company — North American operator of travel centers and truck stops serving professional drivers and travelers.
 *
 * Pilot Company operates a large network of travel centers and truck stops
 * across North America under the Pilot and Flying J brands. It provides
 * fuel, food, and services to professional drivers and travelers, and runs
 * energy and logistics operations. Headquartered in Knoxville, Tennessee.
 *
 * Sector: Transportation & Travel Services. HQ: Knoxville, Tennessee, United States.
 *
 * Source: SmartRecruiters job board, company identifier `PilotCompany`
 * (`https://jobs.smartrecruiters.com/PilotCompany`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PilotCompany';
const COMPANY_NAME = 'Pilot Company';

@SourcePlugin({
  site: Site.PILOT_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PilotCompanyService implements IScraper {
  private readonly logger = new Logger(PilotCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Pilot Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pilot Company: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PILOT_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'pilotcompany-');
      }
    }

    this.logger.log(`Pilot Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
