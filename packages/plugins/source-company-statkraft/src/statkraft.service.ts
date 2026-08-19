import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Statkraft — Norwegian state-owned company and Europe\'s largest generator of renewable energy from hydropower, wind and solar.
 *
 * Statkraft is a Norwegian state-owned enterprise and one of Europe's
 * largest producers of renewable energy. It generates power from hydropower,
 * onshore and offshore wind, and solar, and is active in energy market
 * operations and trading across Europe and beyond.
 *
 * Sector: Renewable Energy. HQ: Oslo, Oslo, Norway.
 *
 * Source: SmartRecruiters job board, company identifier `statkraft1`
 * (`https://jobs.smartrecruiters.com/statkraft1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'statkraft1';
const COMPANY_NAME = 'Statkraft';

@SourcePlugin({
  site: Site.STATKRAFT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StatkraftService implements IScraper {
  private readonly logger = new Logger(StatkraftService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Statkraft',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Statkraft: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STATKRAFT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'statkraft-');
      }
    }

    this.logger.log(`Statkraft: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
