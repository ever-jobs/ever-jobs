import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Assystem — Engineering group focused on infrastructure and energy, including nuclear projects.
 *
 * Assystem is an international engineering company providing design, project
 * management, and technical consulting services. It focuses heavily on the
 * energy sector, including nuclear, as well as transport and other
 * infrastructure. The company is headquartered in France.
 *
 * Sector: Engineering Consultancy. HQ: Courbevoie, France.
 *
 * Source: SmartRecruiters job board, company identifier `ASSYSTEM`
 * (`https://jobs.smartrecruiters.com/ASSYSTEM`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ASSYSTEM';
const COMPANY_NAME = 'Assystem';

@SourcePlugin({
  site: Site.ASSYSTEM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AssystemService implements IScraper {
  private readonly logger = new Logger(AssystemService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Assystem',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Assystem: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASSYSTEM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'assystem-');
      }
    }

    this.logger.log(`Assystem: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
