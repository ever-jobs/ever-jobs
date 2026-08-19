import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Eurofins Scientific — Laboratory group providing analytical testing services across food, environment, pharma, and electronics.
 *
 * Eurofins Scientific is an international group of laboratories providing
 * analytical testing and laboratory services for the pharmaceutical, food,
 * environmental, agroscience, and consumer product industries, as well as
 * electronics and materials testing.
 *
 * Sector: Laboratory testing / Analytical services. HQ: Luxembourg.
 *
 * Source: SmartRecruiters job board, company identifier `Eurofins`
 * (`https://jobs.smartrecruiters.com/Eurofins`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Eurofins';
const COMPANY_NAME = 'Eurofins Scientific';

@SourcePlugin({
  site: Site.EUROFINS_SCIENTIFIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EurofinsScientificService implements IScraper {
  private readonly logger = new Logger(EurofinsScientificService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Eurofins Scientific',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Eurofins Scientific: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EUROFINS_SCIENTIFIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'eurofinsscientific-');
      }
    }

    this.logger.log(`Eurofins Scientific: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
