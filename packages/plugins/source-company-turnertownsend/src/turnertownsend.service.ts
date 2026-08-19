import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Turner & Townsend — Global professional services firm specializing in program management and cost consultancy for construction and real estate.
 *
 * Turner & Townsend is a professional services company providing program
 * management, project management, cost management, and advisory services. It
 * works with clients across real estate, infrastructure, and natural
 * resources sectors. The firm operates in more than 60 countries.
 *
 * Sector: Real Estate & Construction Consultancy. HQ: Leeds, England, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `TurnerTownsend`
 * (`https://jobs.smartrecruiters.com/TurnerTownsend`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'TurnerTownsend';
const COMPANY_NAME = 'Turner & Townsend';

@SourcePlugin({
  site: Site.TURNER_TOWNSEND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TurnerTownsendService implements IScraper {
  private readonly logger = new Logger(TurnerTownsendService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Turner & Townsend',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Turner & Townsend: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TURNER_TOWNSEND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'turnertownsend-');
      }
    }

    this.logger.log(`Turner & Townsend: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
