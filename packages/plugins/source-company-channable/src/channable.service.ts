import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Channable — Feed-management and PPC-automation SaaS that syndicates e-commerce product data to marketplaces, comparison sites, and affiliate platforms.
 *
 * Channable is a Utrecht-based software platform that lets online retailers
 * and agencies optimize and distribute product feeds to marketplaces,
 * price-comparison engines, affiliate networks, and ad channels, and
 * automate pay-per-click campaigns. The public Recruitee board at
 * channable.recruitee.com returned 3 live offers at verification time
 * (commercial roles across DACH and France).
 *
 * Sector: E-commerce SaaS / feed management. HQ: Utrecht, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `channable`
 * (`https://channable.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'channable';
const COMPANY_NAME = 'Channable';

@SourcePlugin({
  site: Site.CHANNABLE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ChannableService implements IScraper {
  private readonly logger = new Logger(ChannableService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Channable',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Channable: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CHANNABLE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'channable-');
      }
    }

    this.logger.log(`Channable: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
