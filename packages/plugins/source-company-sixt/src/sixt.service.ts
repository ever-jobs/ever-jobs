import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SIXT — International vehicle rental and mobility services company.
 *
 * SIXT is a German multinational mobility company headquartered in Pullach,
 * near Munich. It provides car and van rental, car sharing, and integrated
 * mobility services across Europe, North America, and other markets.
 *
 * Sector: Transportation & Mobility. HQ: Pullach, Bavaria, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `Sixt`
 * (`https://jobs.smartrecruiters.com/Sixt`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Sixt';
const COMPANY_NAME = 'SIXT';

@SourcePlugin({
  site: Site.SIXT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SIXTService implements IScraper {
  private readonly logger = new Logger(SIXTService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape SIXT',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `SIXT: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SIXT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'sixt-');
      }
    }

    this.logger.log(`SIXT: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
