import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deutsche Telekom IT Solutions Slovakia — Slovak IT services and delivery center of Deutsche Telekom.
 *
 * Deutsche Telekom IT Solutions Slovakia is a technology delivery center
 * within the Deutsche Telekom group, providing software development, network
 * engineering, and IT operations. It supports cloud and enterprise IT
 * projects across the group. It is one of the largest IT employers in
 * Slovakia.
 *
 * Sector: IT services and enterprise technology. HQ: Kosice, Slovakia.
 *
 * Source: SmartRecruiters job board, company identifier `DeutscheTelekomITSolutionsSlovakia`
 * (`https://jobs.smartrecruiters.com/DeutscheTelekomITSolutionsSlovakia`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'DeutscheTelekomITSolutionsSlovakia';
const COMPANY_NAME = 'Deutsche Telekom IT Solutions Slovakia';

@SourcePlugin({
  site: Site.DEUTSCHE_TELEKOM_IT_SOLUTIONS_SLOVAKIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeutscheTelekomITSolutionsSlovakiaService implements IScraper {
  private readonly logger = new Logger(DeutscheTelekomITSolutionsSlovakiaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Deutsche Telekom IT Solutions Slovakia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deutsche Telekom IT Solutions Slovakia: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEUTSCHE_TELEKOM_IT_SOLUTIONS_SLOVAKIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deutschetelekomitsolutionsslovakia-');
      }
    }

    this.logger.log(`Deutsche Telekom IT Solutions Slovakia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
