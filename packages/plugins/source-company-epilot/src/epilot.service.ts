import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * epilot — Cloud SaaS platform for digitalizing sales and processes in the energy sector.
 *
 * epilot GmbH operates a cloud platform that digitalizes the energy
 * industry, enabling utilities, energy providers, and grid operators to sell
 * and manage complex products online and coordinate with partners. The
 * company is headquartered in Cologne.
 *
 * Sector: Energy software / SaaS. HQ: Cologne, Germany.
 *
 * Source: Recruitee careers board, subdomain `epilot`
 * (`https://epilot.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'epilot';
const COMPANY_NAME = 'epilot';

@SourcePlugin({
  site: Site.EPILOT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EpilotService implements IScraper {
  private readonly logger = new Logger(EpilotService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape epilot',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `epilot: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EPILOT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'epilot-');
      }
    }

    this.logger.log(`epilot: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
