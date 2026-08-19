import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hume City Council — Local government authority for the City of Hume in Victoria, Australia.
 *
 * Hume City Council is the local government authority serving the City of
 * Hume in the northern suburbs of Melbourne, Victoria, Australia. It
 * delivers community, care, infrastructure, and administrative services and
 * hires across local-government roles.
 *
 * Sector: Government / public sector (local government). HQ: Broadmeadows, Victoria, Australia.
 *
 * Source: SmartRecruiters job board, company identifier `HumeCityCouncil`
 * (`https://jobs.smartrecruiters.com/HumeCityCouncil`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'HumeCityCouncil';
const COMPANY_NAME = 'Hume City Council';

@SourcePlugin({
  site: Site.HUME_CITY_COUNCIL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HumeCityCouncilService implements IScraper {
  private readonly logger = new Logger(HumeCityCouncilService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Hume City Council',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hume City Council: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HUME_CITY_COUNCIL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'humecitycouncil-');
      }
    }

    this.logger.log(`Hume City Council: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
