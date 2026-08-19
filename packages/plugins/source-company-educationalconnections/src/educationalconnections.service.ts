import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Educational Connections — Academic tutoring and educational-support services provider.
 *
 * Educational Connections is a tutoring and academic-support company that
 * provides in-person and online tutoring, test preparation, and
 * executive-function coaching for students. It hires part-time tutors and
 * academic-support staff.
 *
 * Sector: Education (tutoring services). HQ: Vienna, Virginia, USA.
 *
 * Source: SmartRecruiters job board, company identifier `EducationalConnections`
 * (`https://jobs.smartrecruiters.com/EducationalConnections`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'EducationalConnections';
const COMPANY_NAME = 'Educational Connections';

@SourcePlugin({
  site: Site.EDUCATIONAL_CONNECTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EducationalConnectionsService implements IScraper {
  private readonly logger = new Logger(EducationalConnectionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Educational Connections',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Educational Connections: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EDUCATIONAL_CONNECTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'educationalconnections-');
      }
    }

    this.logger.log(`Educational Connections: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
