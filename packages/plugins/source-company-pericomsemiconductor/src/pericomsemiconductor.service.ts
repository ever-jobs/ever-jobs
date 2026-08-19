import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pericom Semiconductor — Semiconductor company producing connectivity, timing, and signal integrity ICs.
 *
 * Pericom Semiconductor Corporation designs and manufactures integrated
 * circuits for connectivity, timing, and signal integrity applications. Its
 * products are used in computing, communications, and consumer electronics.
 * It is now part of Diodes Incorporated.
 *
 * Sector: Semiconductors. HQ: Milpitas, California, United States.
 *
 * Source: SmartRecruiters job board, company identifier `PericomSemiconductorCorporation`
 * (`https://jobs.smartrecruiters.com/PericomSemiconductorCorporation`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PericomSemiconductorCorporation';
const COMPANY_NAME = 'Pericom Semiconductor';

@SourcePlugin({
  site: Site.PERICOM_SEMICONDUCTOR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PericomSemiconductorService implements IScraper {
  private readonly logger = new Logger(PericomSemiconductorService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Pericom Semiconductor',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pericom Semiconductor: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PERICOM_SEMICONDUCTOR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'pericomsemiconductor-');
      }
    }

    this.logger.log(`Pericom Semiconductor: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
