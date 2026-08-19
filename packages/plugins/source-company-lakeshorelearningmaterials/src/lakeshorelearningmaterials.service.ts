import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lakeshore Learning Materials — Developer and retailer of educational materials for schools, teachers, and families.
 *
 * Lakeshore Learning Materials is a company that designs, manufactures, and
 * retails educational products and classroom materials for early childhood
 * and K-12 education. It supplies teachers, schools, and families and
 * operates retail stores, distribution centers, and corporate functions.
 *
 * Sector: Education (educational products and materials). HQ: Carson, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Lakeshore`
 * (`https://jobs.smartrecruiters.com/Lakeshore`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Lakeshore';
const COMPANY_NAME = 'Lakeshore Learning Materials';

@SourcePlugin({
  site: Site.LAKESHORE_LEARNING_MATERIALS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LakeshoreLearningMaterialsService implements IScraper {
  private readonly logger = new Logger(LakeshoreLearningMaterialsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Lakeshore Learning Materials',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lakeshore Learning Materials: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LAKESHORE_LEARNING_MATERIALS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'lakeshorelearningmaterials-');
      }
    }

    this.logger.log(`Lakeshore Learning Materials: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
