import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * WSH Group — UK contract catering and hospitality group operating brands including BaxterStorey.
 *
 * WSH Group is a UK-based hospitality and contract catering group
 * headquartered in London. It operates foodservice and hospitality brands
 * such as BaxterStorey, Searcys, and Benugo, serving corporate offices,
 * venues, and events across the UK and Europe.
 *
 * Sector: Hospitality & Catering. HQ: London, England, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `WSHGroup`
 * (`https://jobs.smartrecruiters.com/WSHGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'WSHGroup';
const COMPANY_NAME = 'WSH Group';

@SourcePlugin({
  site: Site.WSH_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WSHGroupService implements IScraper {
  private readonly logger = new Logger(WSHGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape WSH Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `WSH Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WSH_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'wshgroup-');
      }
    }

    this.logger.log(`WSH Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
