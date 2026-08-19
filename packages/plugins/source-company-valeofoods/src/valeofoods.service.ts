import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Valeo Foods — Food manufacturer producing snacks, confectionery, and grocery products across multiple brands.
 *
 * Valeo Foods is an Ireland-based food company that manufactures and markets
 * a portfolio of consumer food brands. Categories include snacking,
 * confectionery, baking, and grocery staples sold across Europe and beyond.
 * The group grows through a mix of owned brands and acquisitions.
 *
 * Sector: Food consumer goods (CPG). HQ: Dublin, Ireland.
 *
 * Source: SmartRecruiters job board, company identifier `valeofoods`
 * (`https://jobs.smartrecruiters.com/valeofoods`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'valeofoods';
const COMPANY_NAME = 'Valeo Foods';

@SourcePlugin({
  site: Site.VALEO_FOODS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ValeoFoodsService implements IScraper {
  private readonly logger = new Logger(ValeoFoodsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Valeo Foods',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Valeo Foods: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VALEO_FOODS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'valeofoods-');
      }
    }

    this.logger.log(`Valeo Foods: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
