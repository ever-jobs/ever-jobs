import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HealthEast — Health care system operating hospitals and clinics in the Minnesota Twin Cities east metro.
 *
 * HealthEast is a Minnesota health care system that operates hospitals and
 * clinics serving the east metro area of the Twin Cities. It provides acute
 * care, clinic-based care, and related health services. It is part of the M
 * Health Fairview system.
 *
 * Sector: Healthcare / Hospital System. HQ: St. Paul, Minnesota, USA.
 *
 * Source: SmartRecruiters job board, company identifier `HealthEastCareSystem`
 * (`https://jobs.smartrecruiters.com/HealthEastCareSystem`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'HealthEastCareSystem';
const COMPANY_NAME = 'HealthEast';

@SourcePlugin({
  site: Site.HEALTHEAST,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HealthEastService implements IScraper {
  private readonly logger = new Logger(HealthEastService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape HealthEast',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `HealthEast: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HEALTHEAST;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'healtheast-');
      }
    }

    this.logger.log(`HealthEast: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
