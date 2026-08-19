import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * AFRY — European engineering and consulting firm with a large energy and renewables practice.
 *
 * AFRY is a Swedish-Finnish engineering, design and advisory company serving
 * the energy, industry and infrastructure sectors. Its energy division works
 * on hydropower, wind, solar PV, grid/HVDC, nuclear and energy transition
 * projects internationally.
 *
 * Sector: Energy Engineering & Consulting. HQ: Stockholm, Stockholm, Sweden.
 *
 * Source: SmartRecruiters job board, company identifier `AFRY`
 * (`https://jobs.smartrecruiters.com/AFRY`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AFRY';
const COMPANY_NAME = 'AFRY';

@SourcePlugin({
  site: Site.AFRY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AFRYService implements IScraper {
  private readonly logger = new Logger(AFRYService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape AFRY',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `AFRY: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AFRY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'afry-');
      }
    }

    this.logger.log(`AFRY: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
