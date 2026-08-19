import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * City of San Antonio — Municipal government of San Antonio, Texas.
 *
 * The City of San Antonio is the municipal government of San Antonio, Texas.
 * It employs staff across public services including public safety, health,
 * engineering, planning, and administration, and posts municipal job
 * openings on its SmartRecruiters careers page.
 *
 * Sector: Government / public sector (municipal government). HQ: San Antonio, Texas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `CityOfSanAntonio`
 * (`https://jobs.smartrecruiters.com/CityOfSanAntonio`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CityOfSanAntonio';
const COMPANY_NAME = 'City of San Antonio';

@SourcePlugin({
  site: Site.CITY_OF_SAN_ANTONIO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CityOfSanAntonioService implements IScraper {
  private readonly logger = new Logger(CityOfSanAntonioService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape City of San Antonio',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `City of San Antonio: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CITY_OF_SAN_ANTONIO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cityofsanantonio-');
      }
    }

    this.logger.log(`City of San Antonio: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
