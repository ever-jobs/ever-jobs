import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Peddler — Sustainable last-mile delivery and urban logistics operator using e-bikes across Dutch cities.
 *
 * Peddler is an Amsterdam-based sustainable last-mile logistics company
 * running e-bike delivery hubs in Dutch cities. The Recruitee board
 * peddler.recruitee.com returned 8 live offers spanning logistics/operations
 * (hub associates and managers in Utrecht, Almere), customer service,
 * HR/payroll and account management, across Amsterdam, Utrecht and Almere.
 *
 * Sector: Last-mile logistics / e-commerce fulfilment. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `peddler`
 * (`https://peddler.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'peddler';
const COMPANY_NAME = 'Peddler';

@SourcePlugin({
  site: Site.PEDDLER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PeddlerService implements IScraper {
  private readonly logger = new Logger(PeddlerService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Peddler',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Peddler: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PEDDLER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'peddler-');
      }
    }

    this.logger.log(`Peddler: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
