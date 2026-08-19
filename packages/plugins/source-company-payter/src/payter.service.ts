import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Payter — Rotterdam company building contactless NFC and cashless payment terminals for unattended points of sale.
 *
 * Payter B.V. is a Rotterdam-based payments company operating since 2007
 * that develops contactless NFC and cashless payment devices for unattended
 * environments such as EV charging, retail and vending. It runs its careers
 * site on Recruitee (payter.recruitee.com), where it listed multiple
 * engineering, product and commercial roles based in the Netherlands.
 *
 * Sector: Payments hardware / unattended payments. HQ: Rotterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `payter`
 * (`https://payter.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'payter';
const COMPANY_NAME = 'Payter';

@SourcePlugin({
  site: Site.PAYTER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PayterService implements IScraper {
  private readonly logger = new Logger(PayterService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Payter',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Payter: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PAYTER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'payter-');
      }
    }

    this.logger.log(`Payter: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
