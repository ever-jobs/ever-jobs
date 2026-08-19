import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Derex Technologies — IT consulting, staffing and software services firm established in 1996.
 *
 * Derex Technologies provides IT consulting, staffing solutions and software
 * services to clients across North America. Established in 1996, it delivers
 * technology professionals and customized talent solutions.
 *
 * Sector: IT consulting and staffing. HQ: Harrison, New Jersey, United States.
 *
 * Source: SmartRecruiters job board, company identifier `DerexTechnologiesInc`
 * (`https://jobs.smartrecruiters.com/DerexTechnologiesInc`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'DerexTechnologiesInc';
const COMPANY_NAME = 'Derex Technologies';

@SourcePlugin({
  site: Site.DEREX_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DerexTechnologiesService implements IScraper {
  private readonly logger = new Logger(DerexTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Derex Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Derex Technologies: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEREX_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'derextechnologies-');
      }
    }

    this.logger.log(`Derex Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
