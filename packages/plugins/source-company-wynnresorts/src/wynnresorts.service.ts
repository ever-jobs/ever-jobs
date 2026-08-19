import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Wynn Resorts — Operator of luxury casino resorts.
 *
 * Wynn Resorts is a developer and operator of high-end casino resorts and
 * hotels, with properties in Las Vegas and other markets. It hires across
 * casino gaming operations, hospitality, food and beverage, and corporate
 * roles.
 *
 * Sector: Casino & Resort Entertainment. HQ: Las Vegas, Nevada, USA.
 *
 * Source: SmartRecruiters job board, company identifier `WynnResorts`
 * (`https://jobs.smartrecruiters.com/WynnResorts`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'WynnResorts';
const COMPANY_NAME = 'Wynn Resorts';

@SourcePlugin({
  site: Site.WYNN_RESORTS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WynnResortsService implements IScraper {
  private readonly logger = new Logger(WynnResortsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Wynn Resorts',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Wynn Resorts: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WYNN_RESORTS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'wynnresorts-');
      }
    }

    this.logger.log(`Wynn Resorts: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
