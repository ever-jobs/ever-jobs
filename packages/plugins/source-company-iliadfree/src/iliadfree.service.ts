import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Iliad / Free — French telecommunications operator providing mobile and fixed connectivity.
 *
 * Iliad, through its Free brand, is a French telecommunications operator
 * offering mobile and fixed broadband services, along with related IT, cloud
 * and data-center activities. It hires engineering, technical, marketing and
 * business roles primarily in France.
 *
 * Sector: Telecommunications. HQ: Paris, France.
 *
 * Source: SmartRecruiters job board, company identifier `Iliad-Free`
 * (`https://jobs.smartrecruiters.com/Iliad-Free`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Iliad-Free';
const COMPANY_NAME = 'Iliad / Free';

@SourcePlugin({
  site: Site.ILIAD_FREE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IliadFreeService implements IScraper {
  private readonly logger = new Logger(IliadFreeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Iliad / Free',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Iliad / Free: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ILIAD_FREE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'iliadfree-');
      }
    }

    this.logger.log(`Iliad / Free: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
