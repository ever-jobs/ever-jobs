import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * The Nielsen Company — Audience measurement and media analytics company.
 *
 * Nielsen is a measurement and data analytics company that measures
 * audiences across television, digital and other media, providing viewership
 * and audience data used by the media and advertising industries. It hires
 * across data operations, analytics, engineering and commercial roles.
 *
 * Sector: Media Measurement & Analytics. HQ: New York, New York, USA.
 *
 * Source: SmartRecruiters job board, company identifier `TheNielsenCompany`
 * (`https://jobs.smartrecruiters.com/TheNielsenCompany`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'TheNielsenCompany';
const COMPANY_NAME = 'The Nielsen Company';

@SourcePlugin({
  site: Site.THE_NIELSEN_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TheNielsenCompanyService implements IScraper {
  private readonly logger = new Logger(TheNielsenCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape The Nielsen Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `The Nielsen Company: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.THE_NIELSEN_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'thenielsencompany-');
      }
    }

    this.logger.log(`The Nielsen Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
