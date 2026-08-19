import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * MobilityPlus — Belgian EV-charging software and infrastructure provider.
 *
 * MobilityPlus is a Ghent-based Belgian EV-charging software and
 * infrastructure company. Its Recruitee board at mobilityplus.recruitee.com
 * listed 6 offers based in Gent, including a Data & BI Engineer and
 * partnership/roaming manager roles.
 *
 * Sector: Software / EV charging. HQ: Ghent, Belgium.
 *
 * Source: Recruitee careers board, subdomain `mobilityplus`
 * (`https://mobilityplus.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'mobilityplus';
const COMPANY_NAME = 'MobilityPlus';

@SourcePlugin({
  site: Site.MOBILITYPLUS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MobilityPlusService implements IScraper {
  private readonly logger = new Logger(MobilityPlusService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape MobilityPlus',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `MobilityPlus: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MOBILITYPLUS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'mobilityplus-');
      }
    }

    this.logger.log(`MobilityPlus: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
