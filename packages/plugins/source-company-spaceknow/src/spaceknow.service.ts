import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SpaceKnow — Geospatial intelligence company analyzing satellite imagery for defense and commercial use.
 *
 * SpaceKnow is a geospatial analytics company that processes satellite and
 * aerial imagery to produce intelligence for defense, government, and
 * commercial customers. It applies machine learning to remote sensing data
 * for monitoring applications.
 *
 * Sector: Aerospace & defense (geospatial analytics). HQ: San Francisco, California, United States.
 *
 * Source: SmartRecruiters job board, company identifier `SpaceknowInc`
 * (`https://jobs.smartrecruiters.com/SpaceknowInc`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SpaceknowInc';
const COMPANY_NAME = 'SpaceKnow';

@SourcePlugin({
  site: Site.SPACEKNOW,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpaceKnowService implements IScraper {
  private readonly logger = new Logger(SpaceKnowService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape SpaceKnow',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `SpaceKnow: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPACEKNOW;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'spaceknow-');
      }
    }

    this.logger.log(`SpaceKnow: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
