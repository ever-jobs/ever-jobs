import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * EcoVadis — France-based provider of business sustainability ratings and supply-chain assessments.
 *
 * EcoVadis is a Paris-headquartered company providing business
 * sustainability ratings and performance-monitoring tools. It assesses
 * companies on environmental, social and ethical criteria to support
 * responsible procurement and supply-chain management for global
 * enterprises.
 *
 * Sector: Sustainability ratings & software. HQ: Paris, France.
 *
 * Source: SmartRecruiters job board, company identifier `ecovadis`
 * (`https://jobs.smartrecruiters.com/ecovadis`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ecovadis';
const COMPANY_NAME = 'EcoVadis';

@SourcePlugin({
  site: Site.ECOVADIS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EcoVadisService implements IScraper {
  private readonly logger = new Logger(EcoVadisService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape EcoVadis',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `EcoVadis: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ECOVADIS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'ecovadis-');
      }
    }

    this.logger.log(`EcoVadis: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
