import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * bunq — Amsterdam-based mobile neobank offering personal and business banking across Europe.
 *
 * bunq is a Dutch digital bank founded in 2012 and headquartered in
 * Amsterdam, holding a European banking licence. It operates a mobile-first
 * banking app with personal and business accounts, cards, savings and
 * multi-currency features, and is one of the larger EU neobanks by user
 * base. Its Recruitee board (bunq.recruitee.com) lists banking, risk, legal
 * and operations roles in Amsterdam.
 *
 * Sector: Neobank / digital banking. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `bunq`
 * (`https://bunq.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'bunq';
const COMPANY_NAME = 'bunq';

@SourcePlugin({
  site: Site.BUNQ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BunqService implements IScraper {
  private readonly logger = new Logger(BunqService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape bunq',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `bunq: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BUNQ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'bunq-');
      }
    }

    this.logger.log(`bunq: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
