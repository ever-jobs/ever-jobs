import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Renesas Electronics — Semiconductor manufacturer producing microcontrollers and analog, power, and connectivity chips.
 *
 * Renesas Electronics Corporation is a semiconductor manufacturer supplying
 * microcontrollers, microprocessors, and analog, power, and connectivity
 * products. Its chips are widely used in automotive, industrial, and
 * infrastructure applications.
 *
 * Sector: Semiconductor manufacturing. HQ: Tokyo, Japan.
 *
 * Source: SmartRecruiters job board, company identifier `RenesasElectronics`
 * (`https://jobs.smartrecruiters.com/RenesasElectronics`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'RenesasElectronics';
const COMPANY_NAME = 'Renesas Electronics';

@SourcePlugin({
  site: Site.RENESAS_ELECTRONICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RenesasElectronicsService implements IScraper {
  private readonly logger = new Logger(RenesasElectronicsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Renesas Electronics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Renesas Electronics: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RENESAS_ELECTRONICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'renesaselectronics-');
      }
    }

    this.logger.log(`Renesas Electronics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
