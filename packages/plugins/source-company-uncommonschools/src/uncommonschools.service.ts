import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Uncommon Schools — Non-profit network of public charter schools across New York, New Jersey, and Massachusetts.
 *
 * Uncommon Schools is a non-profit network of public charter schools
 * operating campuses across New York, New Jersey, and Massachusetts. It runs
 * K-12 schools focused on college preparation and hires teachers, coaches,
 * and school-support staff.
 *
 * Sector: Education (K-12 public charter schools / non-profit). HQ: New York, New York, USA.
 *
 * Source: SmartRecruiters job board, company identifier `UncommonSchools`
 * (`https://jobs.smartrecruiters.com/UncommonSchools`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'UncommonSchools';
const COMPANY_NAME = 'Uncommon Schools';

@SourcePlugin({
  site: Site.UNCOMMON_SCHOOLS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UncommonSchoolsService implements IScraper {
  private readonly logger = new Logger(UncommonSchoolsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Uncommon Schools',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Uncommon Schools: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UNCOMMON_SCHOOLS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'uncommonschools-');
      }
    }

    this.logger.log(`Uncommon Schools: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
