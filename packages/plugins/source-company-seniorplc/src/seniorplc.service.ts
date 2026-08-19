import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Senior plc — Engineering group manufacturing components and systems for aerospace, defense, and energy.
 *
 * Senior plc is an international engineering solutions provider operating
 * multiple businesses across several countries. It designs and manufactures
 * high-technology components and systems for the aerospace, defense, land
 * vehicle, and power and energy markets, including its Senior Aerospace SSP
 * business.
 *
 * Sector: Aerospace & defense (engineered components). HQ: Rickmansworth, England, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `SeniorPlc1`
 * (`https://jobs.smartrecruiters.com/SeniorPlc1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SeniorPlc1';
const COMPANY_NAME = 'Senior plc';

@SourcePlugin({
  site: Site.SENIOR_PLC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SeniorPlcService implements IScraper {
  private readonly logger = new Logger(SeniorPlcService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Senior plc',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Senior plc: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SENIOR_PLC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'seniorplc-');
      }
    }

    this.logger.log(`Senior plc: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
