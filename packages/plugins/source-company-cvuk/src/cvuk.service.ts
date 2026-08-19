import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CVUK — UK recruitment consultancy specialising in fashion and retail talent.
 *
 * CVUK is a United Kingdom recruitment consultancy focused on the fashion
 * and retail sectors. It places permanent, contract and freelance talent
 * across design, buying, merchandising and related roles for brands and
 * retailers.
 *
 * Sector: Recruitment (fashion & retail). HQ: United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `CVUK`
 * (`https://jobs.smartrecruiters.com/CVUK`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CVUK';
const COMPANY_NAME = 'CVUK';

@SourcePlugin({
  site: Site.CVUK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CVUKService implements IScraper {
  private readonly logger = new Logger(CVUKService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape CVUK',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `CVUK: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CVUK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cvuk-');
      }
    }

    this.logger.log(`CVUK: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
