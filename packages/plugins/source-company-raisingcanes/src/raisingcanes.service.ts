import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Raising Cane\'s — Fast-food restaurant chain specializing in chicken finger meals.
 *
 * Raising Cane's Chicken Fingers is an American quick-service restaurant
 * chain founded in 1996 in Baton Rouge, Louisiana. Its menu is centered on
 * chicken finger meals with crinkle-cut fries, Texas toast, coleslaw, and
 * its signature sauce. The company operates hundreds of locations across the
 * United States and internationally.
 *
 * Sector: Restaurants (Quick-Service). HQ: Plano, Texas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `RaisingCanes`
 * (`https://jobs.smartrecruiters.com/RaisingCanes`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'RaisingCanes';
const COMPANY_NAME = 'Raising Cane\'s';

@SourcePlugin({
  site: Site.RAISING_CANE_S,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RaisingCaneSService implements IScraper {
  private readonly logger = new Logger(RaisingCaneSService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Raising Cane\'s',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Raising Cane\'s: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RAISING_CANE_S;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'raisingcanes-');
      }
    }

    this.logger.log(`Raising Cane\'s: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
