import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Maxim Integrated — Analog and mixed-signal semiconductor brand (part of Analog Devices).
 *
 * Maxim Integrated designs and manufactures analog and mixed-signal
 * integrated circuits for automotive, industrial, communications, and
 * consumer applications. It is now part of Analog Devices and maintains
 * semiconductor test and engineering operations.
 *
 * Sector: Semiconductors. HQ: San Jose, California, United States.
 *
 * Source: SmartRecruiters job board, company identifier `MaximIntegrated`
 * (`https://jobs.smartrecruiters.com/MaximIntegrated`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'MaximIntegrated';
const COMPANY_NAME = 'Maxim Integrated';

@SourcePlugin({
  site: Site.MAXIM_INTEGRATED,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MaximIntegratedService implements IScraper {
  private readonly logger = new Logger(MaximIntegratedService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Maxim Integrated',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Maxim Integrated: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MAXIM_INTEGRATED;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'maximintegrated-');
      }
    }

    this.logger.log(`Maxim Integrated: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
