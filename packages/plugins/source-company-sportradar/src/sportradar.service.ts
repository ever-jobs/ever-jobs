import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sportradar — Sports technology company at the intersection of sports, media and betting.
 *
 * Sportradar is a sports technology company that collects and distributes
 * sports data and provides technology to sports federations, media outlets
 * and betting operators. It hires software engineers, data operators, sales
 * and product roles across many countries.
 *
 * Sector: Sports Media & Betting Technology. HQ: St. Gallen, Switzerland.
 *
 * Source: SmartRecruiters job board, company identifier `Sportradar`
 * (`https://jobs.smartrecruiters.com/Sportradar`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Sportradar';
const COMPANY_NAME = 'Sportradar';

@SourcePlugin({
  site: Site.SPORTRADAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SportradarService implements IScraper {
  private readonly logger = new Logger(SportradarService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Sportradar',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sportradar: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPORTRADAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'sportradar-');
      }
    }

    this.logger.log(`Sportradar: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
