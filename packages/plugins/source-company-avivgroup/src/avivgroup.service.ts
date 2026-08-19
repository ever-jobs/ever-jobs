import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * AVIV Group — Operator of online real-estate media and marketplace platforms.
 *
 * AVIV Group is a digital company operating online real-estate marketplaces
 * and media platforms across Europe, and is part of the Axel Springer group.
 * It hires across sales, product, technology and marketing roles.
 *
 * Sector: Digital Media & Marketplaces. HQ: Paris, France.
 *
 * Source: SmartRecruiters job board, company identifier `avivgroup`
 * (`https://jobs.smartrecruiters.com/avivgroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'avivgroup';
const COMPANY_NAME = 'AVIV Group';

@SourcePlugin({
  site: Site.AVIV_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AVIVGroupService implements IScraper {
  private readonly logger = new Logger(AVIVGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape AVIV Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `AVIV Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AVIV_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'avivgroup-');
      }
    }

    this.logger.log(`AVIV Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
