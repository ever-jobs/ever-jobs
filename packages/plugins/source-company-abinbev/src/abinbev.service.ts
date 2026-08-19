import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * AB InBev — Multinational brewing company producing beer and beverage brands.
 *
 * Anheuser-Busch InBev (AB InBev) is a multinational drinks and brewing
 * company. It produces and distributes a large portfolio of beer brands
 * globally, along with other beverages, and operates breweries and
 * distribution across many countries. It is headquartered in Leuven,
 * Belgium.
 *
 * Sector: Beverages (Brewing). HQ: Leuven, Belgium.
 *
 * Source: SmartRecruiters job board, company identifier `ABInBev1`
 * (`https://jobs.smartrecruiters.com/ABInBev1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ABInBev1';
const COMPANY_NAME = 'AB InBev';

@SourcePlugin({
  site: Site.AB_INBEV,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ABInBevService implements IScraper {
  private readonly logger = new Logger(ABInBevService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape AB InBev',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `AB InBev: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AB_INBEV;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'abinbev-');
      }
    }

    this.logger.log(`AB InBev: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
