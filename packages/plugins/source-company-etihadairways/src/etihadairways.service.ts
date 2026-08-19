import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Etihad Airways — The national airline of the United Arab Emirates, operating passenger and cargo flights from its Abu Dhabi hub.
 *
 * Etihad Airways is the flag carrier of the United Arab Emirates,
 * headquartered in Abu Dhabi. It operates scheduled passenger and cargo
 * services to destinations across the Middle East, Asia, Europe, Africa, and
 * the Americas. Roles span cabin crew, pilots, engineering, and corporate
 * functions.
 *
 * Sector: Airlines. HQ: Abu Dhabi, Abu Dhabi, United Arab Emirates.
 *
 * Source: SmartRecruiters job board, company identifier `EtihadAirways5`
 * (`https://jobs.smartrecruiters.com/EtihadAirways5`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'EtihadAirways5';
const COMPANY_NAME = 'Etihad Airways';

@SourcePlugin({
  site: Site.ETIHAD_AIRWAYS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EtihadAirwaysService implements IScraper {
  private readonly logger = new Logger(EtihadAirwaysService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Etihad Airways',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Etihad Airways: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ETIHAD_AIRWAYS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'etihadairways-');
      }
    }

    this.logger.log(`Etihad Airways: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
