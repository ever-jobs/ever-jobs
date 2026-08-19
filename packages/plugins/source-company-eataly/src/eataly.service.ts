import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Eataly — Italian food marketplace combining grocery retail, restaurants, and cafes.
 *
 * Eataly is a large-format Italian food and beverage marketplace that
 * combines grocery retail with restaurants, cafes, and to-go counters under
 * one roof. Eataly North America operates locations across the United States
 * and Canada, hiring for culinary, retail, and food-service roles.
 *
 * Sector: Food & Beverage Retail / Restaurants. HQ: New York, New York, USA (North America).
 *
 * Source: SmartRecruiters job board, company identifier `Eataly`
 * (`https://jobs.smartrecruiters.com/Eataly`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Eataly';
const COMPANY_NAME = 'Eataly';

@SourcePlugin({
  site: Site.EATALY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EatalyService implements IScraper {
  private readonly logger = new Logger(EatalyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Eataly',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Eataly: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EATALY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'eataly-');
      }
    }

    this.logger.log(`Eataly: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
