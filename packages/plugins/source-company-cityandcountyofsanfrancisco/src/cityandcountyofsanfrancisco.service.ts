import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * City and County of San Francisco — Consolidated city-county government of San Francisco, California.
 *
 * The City and County of San Francisco is the consolidated municipal and
 * county government of San Francisco, California. It employs staff across
 * numerous departments including public health, human rights, and city
 * services, and publishes its job openings on its SmartRecruiters careers
 * page.
 *
 * Sector: Government / public sector (municipal and county government). HQ: San Francisco, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `cityandcountyofsanfrancisco1`
 * (`https://jobs.smartrecruiters.com/cityandcountyofsanfrancisco1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'cityandcountyofsanfrancisco1';
const COMPANY_NAME = 'City and County of San Francisco';

@SourcePlugin({
  site: Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CityAndCountyOfSanFranciscoService implements IScraper {
  private readonly logger = new Logger(CityAndCountyOfSanFranciscoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape City and County of San Francisco',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `City and County of San Francisco: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cityandcountyofsanfrancisco-');
      }
    }

    this.logger.log(`City and County of San Francisco: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
