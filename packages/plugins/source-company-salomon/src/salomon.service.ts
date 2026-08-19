import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Salomon — Outdoor sports brand producing footwear, apparel, and equipment, part of Amer Sports.
 *
 * Salomon is a French outdoor sports brand founded in 1947 in the French
 * Alps, now part of Amer Sports. It designs and sells footwear, apparel, and
 * gear for running, hiking, and snow sports. The brand sells through
 * wholesale, its own retail stores, and e-commerce.
 *
 * Sector: Sporting goods & outdoor apparel/footwear. HQ: Annecy, France.
 *
 * Source: SmartRecruiters job board, company identifier `Salomon`
 * (`https://jobs.smartrecruiters.com/Salomon`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Salomon';
const COMPANY_NAME = 'Salomon';

@SourcePlugin({
  site: Site.SALOMON,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SalomonService implements IScraper {
  private readonly logger = new Logger(SalomonService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Salomon',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Salomon: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SALOMON;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'salomon-');
      }
    }

    this.logger.log(`Salomon: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
