import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Alphacomm — Digital goods and payments infrastructure provider for telcos, airlines, OTAs, and retailers.
 *
 * Alphacomm is a Rotterdam-based digital goods and SaaS company providing
 * payments and digital-goods infrastructure (brands including Checkmaxx and
 * Collectmaxx) for telcos, airlines, OTAs, and retailers across Europe.
 *
 * Sector: Payments / digital-goods SaaS. HQ: Rotterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `alphacomm`
 * (`https://alphacomm.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'alphacomm';
const COMPANY_NAME = 'Alphacomm';

@SourcePlugin({
  site: Site.ALPHACOMM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AlphacommService implements IScraper {
  private readonly logger = new Logger(AlphacommService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Alphacomm',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Alphacomm: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ALPHACOMM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'alphacomm-');
      }
    }

    this.logger.log(`Alphacomm: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
