import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Atria Group — IT staffing, consulting and software development firm.
 *
 * Atria Group provides staffing, consulting, software development and
 * training services in the information technology domain. It places
 * technology professionals with clients across the United States.
 *
 * Sector: IT staffing and consulting. HQ: Bloomington, Minnesota, United States.
 *
 * Source: SmartRecruiters job board, company identifier `AtriaGroupLLC`
 * (`https://jobs.smartrecruiters.com/AtriaGroupLLC`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AtriaGroupLLC';
const COMPANY_NAME = 'Atria Group';

@SourcePlugin({
  site: Site.ATRIA_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AtriaGroupService implements IScraper {
  private readonly logger = new Logger(AtriaGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Atria Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Atria Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ATRIA_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'atriagroup-');
      }
    }

    this.logger.log(`Atria Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
