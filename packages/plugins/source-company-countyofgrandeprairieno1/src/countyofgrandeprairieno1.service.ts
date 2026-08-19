import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * County of Grande Prairie No. 1 — Municipal district government in Alberta, Canada.
 *
 * The County of Grande Prairie No. 1 is a municipal district government in
 * Alberta, Canada. It provides local-government services such as public
 * works, infrastructure, and community services, and hires operational and
 * administrative staff including equipment operators.
 *
 * Sector: Government / public sector (local government). HQ: Grande Prairie, Alberta, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `CountyOfGrandePrairieNo1`
 * (`https://jobs.smartrecruiters.com/CountyOfGrandePrairieNo1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CountyOfGrandePrairieNo1';
const COMPANY_NAME = 'County of Grande Prairie No. 1';

@SourcePlugin({
  site: Site.COUNTY_OF_GRANDE_PRAIRIE_NO_1,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CountyOfGrandePrairieNo1Service implements IScraper {
  private readonly logger = new Logger(CountyOfGrandePrairieNo1Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape County of Grande Prairie No. 1',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `County of Grande Prairie No. 1: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COUNTY_OF_GRANDE_PRAIRIE_NO_1;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'countyofgrandeprairieno1-');
      }
    }

    this.logger.log(`County of Grande Prairie No. 1: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
