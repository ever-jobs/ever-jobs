import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Auberge Resorts Collection — Luxury hotel and resort group with extensive restaurant and food-and-beverage operations.
 *
 * Auberge Resorts Collection is a portfolio of luxury hotels, resorts,
 * residences, and private clubs. Each property operates its own restaurants,
 * bars, and food-and-beverage programs, and the group hires extensively for
 * culinary and F&B roles. It is headquartered in Mill Valley, California.
 *
 * Sector: Restaurants & Hospitality (Food & Beverage). HQ: Mill Valley, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `AubergeCollection`
 * (`https://jobs.smartrecruiters.com/AubergeCollection`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AubergeCollection';
const COMPANY_NAME = 'Auberge Resorts Collection';

@SourcePlugin({
  site: Site.AUBERGE_RESORTS_COLLECTION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AubergeResortsCollectionService implements IScraper {
  private readonly logger = new Logger(AubergeResortsCollectionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Auberge Resorts Collection',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Auberge Resorts Collection: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AUBERGE_RESORTS_COLLECTION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'aubergeresortscollection-');
      }
    }

    this.logger.log(`Auberge Resorts Collection: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
