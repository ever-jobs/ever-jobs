import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lasan Group — UK restaurant group operating Indian dining and hospitality concepts.
 *
 * Lasan Group is a Birmingham-based UK restaurant and hospitality company
 * operating a collection of Indian cuisine restaurants and related dining
 * concepts. It hires for restaurant management and front-of-house roles
 * across its venues.
 *
 * Sector: Restaurants (Full-Service). HQ: Birmingham, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `LasanGroup`
 * (`https://jobs.smartrecruiters.com/LasanGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'LasanGroup';
const COMPANY_NAME = 'Lasan Group';

@SourcePlugin({
  site: Site.LASAN_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LasanGroupService implements IScraper {
  private readonly logger = new Logger(LasanGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Lasan Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lasan Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LASAN_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'lasangroup-');
      }
    }

    this.logger.log(`Lasan Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
