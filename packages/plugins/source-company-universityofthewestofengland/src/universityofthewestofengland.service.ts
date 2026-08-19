import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * University of the West of England — Public research university based in Bristol, England.
 *
 * The University of the West of England (UWE Bristol) is a public research
 * university located in Bristol, United Kingdom. It offers undergraduate and
 * postgraduate programs across faculties including business, health,
 * engineering, arts, and social sciences, and hires academic and
 * professional-services staff.
 *
 * Sector: Education (higher education). HQ: Bristol, England, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `UniversityOfTheWestOfEngland`
 * (`https://jobs.smartrecruiters.com/UniversityOfTheWestOfEngland`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'UniversityOfTheWestOfEngland';
const COMPANY_NAME = 'University of the West of England';

@SourcePlugin({
  site: Site.UNIVERSITY_OF_THE_WEST_OF_ENGLAND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UniversityOfTheWestOfEnglandService implements IScraper {
  private readonly logger = new Logger(UniversityOfTheWestOfEnglandService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape University of the West of England',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `University of the West of England: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UNIVERSITY_OF_THE_WEST_OF_ENGLAND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'universityofthewestofengland-');
      }
    }

    this.logger.log(`University of the West of England: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
