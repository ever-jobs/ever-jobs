import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Constance Hotels & Resorts — Luxury hotel and resort operator in the Indian Ocean region.
 *
 * Constance Hospitality Management operates luxury hotels and resorts under
 * the Constance Hotels & Resorts brand across Indian Ocean destinations
 * including Mauritius, Seychelles, the Maldives, and Madagascar. The group
 * is based in Mauritius.
 *
 * Sector: Hospitality. HQ: Beau Bassin, Plaines Wilhems, Mauritius.
 *
 * Source: SmartRecruiters job board, company identifier `ConstanceHospitalityManagement`
 * (`https://jobs.smartrecruiters.com/ConstanceHospitalityManagement`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ConstanceHospitalityManagement';
const COMPANY_NAME = 'Constance Hotels & Resorts';

@SourcePlugin({
  site: Site.CONSTANCE_HOTELS_RESORTS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ConstanceHotelsResortsService implements IScraper {
  private readonly logger = new Logger(ConstanceHotelsResortsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Constance Hotels & Resorts',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Constance Hotels & Resorts: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONSTANCE_HOTELS_RESORTS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'constancehotelsresorts-');
      }
    }

    this.logger.log(`Constance Hotels & Resorts: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
