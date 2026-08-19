import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Accor — Global hotel group operating a portfolio of hospitality brands worldwide.
 *
 * Accor is a France-based multinational hospitality group headquartered near
 * Paris. It operates and franchises hotels, resorts, and residences across
 * economy to luxury segments under brands including Sofitel, Novotel,
 * Mercure, ibis, Fairmont, and Raffles.
 *
 * Sector: Hospitality. HQ: Issy-les-Moulineaux, Ile-de-France, France.
 *
 * Source: SmartRecruiters job board, company identifier `Accor`
 * (`https://jobs.smartrecruiters.com/Accor`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Accor';
const COMPANY_NAME = 'Accor';

@SourcePlugin({
  site: Site.ACCOR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AccorService implements IScraper {
  private readonly logger = new Logger(AccorService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Accor',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Accor: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ACCOR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'accor-');
      }
    }

    this.logger.log(`Accor: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
