import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Suntiva — Management consulting firm serving US federal government clients.
 *
 * Suntiva is a management consulting firm focused on helping US federal
 * government organizations improve how they lead people and drive results.
 * It provides organizational transformation, human capital and program
 * services.
 *
 * Sector: Management consulting. HQ: Falls Church, Virginia, United States.
 *
 * Source: SmartRecruiters job board, company identifier `SuntivaLLC`
 * (`https://jobs.smartrecruiters.com/SuntivaLLC`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SuntivaLLC';
const COMPANY_NAME = 'Suntiva';

@SourcePlugin({
  site: Site.SUNTIVA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SuntivaService implements IScraper {
  private readonly logger = new Logger(SuntivaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Suntiva',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Suntiva: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SUNTIVA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'suntiva-');
      }
    }

    this.logger.log(`Suntiva: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
