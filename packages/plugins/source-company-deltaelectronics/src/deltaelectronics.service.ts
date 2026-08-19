import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Delta Electronics — Manufacturer of power supplies, industrial automation, and thermal management products.
 *
 * Delta Electronics is a provider of power and thermal management solutions.
 * Its portfolio includes switching power supplies, industrial automation,
 * building automation, and infrastructure products for a range of
 * industries.
 *
 * Sector: Industrial electronics / Power & automation. HQ: Taipei, Taiwan.
 *
 * Source: SmartRecruiters job board, company identifier `DeltaElectronics`
 * (`https://jobs.smartrecruiters.com/DeltaElectronics`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'DeltaElectronics';
const COMPANY_NAME = 'Delta Electronics';

@SourcePlugin({
  site: Site.DELTA_ELECTRONICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeltaElectronicsService implements IScraper {
  private readonly logger = new Logger(DeltaElectronicsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Delta Electronics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Delta Electronics: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELTA_ELECTRONICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deltaelectronics-');
      }
    }

    this.logger.log(`Delta Electronics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
