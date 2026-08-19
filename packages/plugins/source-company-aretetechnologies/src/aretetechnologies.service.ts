import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Arete Technologies — IT consulting and staffing firm providing workforce solutions.
 *
 * Arete Technologies is an IT consulting and staffing company that provides
 * technology talent and workforce solutions to enterprise and public-sector
 * clients across the United States.
 *
 * Sector: IT consulting and staffing. HQ: Fremont, California, United States.
 *
 * Source: SmartRecruiters job board, company identifier `AreteTechnologiesInc`
 * (`https://jobs.smartrecruiters.com/AreteTechnologiesInc`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AreteTechnologiesInc';
const COMPANY_NAME = 'Arete Technologies';

@SourcePlugin({
  site: Site.ARETE_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AreteTechnologiesService implements IScraper {
  private readonly logger = new Logger(AreteTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Arete Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Arete Technologies: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARETE_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'aretetechnologies-');
      }
    }

    this.logger.log(`Arete Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
