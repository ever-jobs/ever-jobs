import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * City of Philadelphia — Municipal government of Philadelphia, Pennsylvania.
 *
 * The City of Philadelphia is the municipal government of Philadelphia,
 * Pennsylvania. It employs staff across city departments including project
 * management, public services, and administration, and posts its job
 * openings on its SmartRecruiters careers page.
 *
 * Sector: Government / public sector (municipal government). HQ: Philadelphia, Pennsylvania, USA.
 *
 * Source: SmartRecruiters job board, company identifier `CityofPhiladelphia`
 * (`https://jobs.smartrecruiters.com/CityofPhiladelphia`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CityofPhiladelphia';
const COMPANY_NAME = 'City of Philadelphia';

@SourcePlugin({
  site: Site.CITY_OF_PHILADELPHIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CityOfPhiladelphiaService implements IScraper {
  private readonly logger = new Logger(CityOfPhiladelphiaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape City of Philadelphia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `City of Philadelphia: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CITY_OF_PHILADELPHIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cityofphiladelphia-');
      }
    }

    this.logger.log(`City of Philadelphia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
