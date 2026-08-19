import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Boyd Gaming — US casino and gaming entertainment operator.
 *
 * Boyd Gaming Corporation is a casino entertainment company that owns and
 * operates gaming, hospitality and entertainment properties across multiple
 * US states. It hires for casino operations, hospitality, food and beverage,
 * and corporate roles.
 *
 * Sector: Gaming & Casino Entertainment. HQ: Las Vegas, Nevada, USA.
 *
 * Source: SmartRecruiters job board, company identifier `BoydGaming`
 * (`https://jobs.smartrecruiters.com/BoydGaming`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'BoydGaming';
const COMPANY_NAME = 'Boyd Gaming';

@SourcePlugin({
  site: Site.BOYD_GAMING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BoydGamingService implements IScraper {
  private readonly logger = new Logger(BoydGamingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Boyd Gaming',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Boyd Gaming: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BOYD_GAMING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'boydgaming-');
      }
    }

    this.logger.log(`Boyd Gaming: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
