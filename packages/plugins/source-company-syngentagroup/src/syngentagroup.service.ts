import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Syngenta Group — Swiss-headquartered global agriculture company in crop protection and seeds.
 *
 * Syngenta Group is a global agricultural science and technology company
 * headquartered in Basel, Switzerland. It develops crop-protection products,
 * seeds and digital agriculture solutions for farmers worldwide, and
 * operates as part of a group with significant Chinese ownership.
 *
 * Sector: Agriculture (crop protection & seeds). HQ: Basel, Switzerland.
 *
 * Source: SmartRecruiters job board, company identifier `SyngentaGroup`
 * (`https://jobs.smartrecruiters.com/SyngentaGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SyngentaGroup';
const COMPANY_NAME = 'Syngenta Group';

@SourcePlugin({
  site: Site.SYNGENTA_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SyngentaGroupService implements IScraper {
  private readonly logger = new Logger(SyngentaGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Syngenta Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Syngenta Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SYNGENTA_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'syngentagroup-');
      }
    }

    this.logger.log(`Syngenta Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
