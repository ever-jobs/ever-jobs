import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * WEBB Traders — Amsterdam proprietary trading firm and market maker in cash equities and derivatives across global exchanges.
 *
 * WEBB Traders BV is a proprietary trading company headquartered in
 * Amsterdam (with a presence in Paris), trading its own capital as a market
 * maker in cash equities and derivatives, including crypto, across global
 * exchanges since 2009. Its Recruitee board (webbtraders.recruitee.com)
 * listed eight roles spanning trading, quantitative, data and software
 * engineering.
 *
 * Sector: Proprietary trading / market making. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `webbtraders`
 * (`https://webbtraders.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'webbtraders';
const COMPANY_NAME = 'WEBB Traders';

@SourcePlugin({
  site: Site.WEBB_TRADERS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WEBBTradersService implements IScraper {
  private readonly logger = new Logger(WEBBTradersService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape WEBB Traders',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `WEBB Traders: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WEBB_TRADERS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'webbtraders-');
      }
    }

    this.logger.log(`WEBB Traders: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
