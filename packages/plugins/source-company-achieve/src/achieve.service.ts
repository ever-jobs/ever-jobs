import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Achieve — Digital personal finance company offering lending and debt resolution products.
 *
 * Achieve is a digital personal finance company that provides personal
 * loans, home equity lending, and debt resolution and settlement services to
 * consumers. It focuses on helping people manage and reduce debt.
 *
 * Sector: Fintech / consumer finance & lending. HQ: Tempe, Arizona, USA (San Mateo, CA).
 *
 * Source: SmartRecruiters job board, company identifier `Achieve1`
 * (`https://jobs.smartrecruiters.com/Achieve1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Achieve1';
const COMPANY_NAME = 'Achieve';

@SourcePlugin({
  site: Site.ACHIEVE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AchieveService implements IScraper {
  private readonly logger = new Logger(AchieveService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Achieve',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Achieve: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ACHIEVE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'achieve-');
      }
    }

    this.logger.log(`Achieve: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
