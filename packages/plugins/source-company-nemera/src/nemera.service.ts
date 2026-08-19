import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Nemera — Designer and manufacturer of drug delivery devices for the pharmaceutical industry.
 *
 * Nemera designs, develops, and manufactures drug delivery devices,
 * including inhalers, injectables, ophthalmic, nasal, and dermal delivery
 * systems for pharmaceutical and biotech companies. It operates
 * manufacturing and development sites internationally. The company is
 * headquartered in France.
 *
 * Sector: Medical Devices / Drug Delivery. HQ: La Verpillière, France.
 *
 * Source: SmartRecruiters job board, company identifier `Nemera`
 * (`https://jobs.smartrecruiters.com/Nemera`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Nemera';
const COMPANY_NAME = 'Nemera';

@SourcePlugin({
  site: Site.NEMERA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NemeraService implements IScraper {
  private readonly logger = new Logger(NemeraService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Nemera',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Nemera: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NEMERA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'nemera-');
      }
    }

    this.logger.log(`Nemera: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
