import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Texas Health Resources — Faith-based, non-profit health system serving north Texas.
 *
 * Texas Health Resources is a non-profit, faith-based health system
 * operating hospitals, outpatient facilities, and physician groups across
 * the Dallas-Fort Worth area of north Texas. It provides acute, specialty,
 * and community care.
 *
 * Sector: Healthcare / Hospital System. HQ: Arlington, Texas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `TexasHealthResources`
 * (`https://jobs.smartrecruiters.com/TexasHealthResources`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'TexasHealthResources';
const COMPANY_NAME = 'Texas Health Resources';

@SourcePlugin({
  site: Site.TEXAS_HEALTH_RESOURCES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TexasHealthResourcesService implements IScraper {
  private readonly logger = new Logger(TexasHealthResourcesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Texas Health Resources',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Texas Health Resources: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TEXAS_HEALTH_RESOURCES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'texashealthresources-');
      }
    }

    this.logger.log(`Texas Health Resources: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
