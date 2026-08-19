import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HealthPartners — Integrated non-profit health care provider and health insurance organization in Minnesota.
 *
 * HealthPartners is a Minnesota-based, non-profit organization that combines
 * a care delivery system of hospitals and clinics with a health insurance
 * plan. It provides medical care, dental care, and coverage to members and
 * patients across the upper Midwest.
 *
 * Sector: Healthcare / Integrated Health System. HQ: Bloomington, Minnesota, USA.
 *
 * Source: SmartRecruiters job board, company identifier `HealthPartners1`
 * (`https://jobs.smartrecruiters.com/HealthPartners1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'HealthPartners1';
const COMPANY_NAME = 'HealthPartners';

@SourcePlugin({
  site: Site.HEALTHPARTNERS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HealthPartnersService implements IScraper {
  private readonly logger = new Logger(HealthPartnersService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape HealthPartners',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `HealthPartners: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HEALTHPARTNERS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'healthpartners-');
      }
    }

    this.logger.log(`HealthPartners: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
