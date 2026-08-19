import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hoist Group — Provider of technology and connectivity solutions for hotels across EMEA.
 *
 * Hoist Group is a hospitality-focused technology company headquartered in
 * Stockholm, Sweden. It provides internet connectivity, property management
 * systems, and other digital solutions to hotels and hospitality venues
 * across Europe, the Middle East, and Africa.
 *
 * Sector: Hospitality Technology. HQ: Stockholm, Stockholm, Sweden.
 *
 * Source: SmartRecruiters job board, company identifier `HoistGroup`
 * (`https://jobs.smartrecruiters.com/HoistGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'HoistGroup';
const COMPANY_NAME = 'Hoist Group';

@SourcePlugin({
  site: Site.HOIST_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HoistGroupService implements IScraper {
  private readonly logger = new Logger(HoistGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Hoist Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hoist Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HOIST_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'hoistgroup-');
      }
    }

    this.logger.log(`Hoist Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
