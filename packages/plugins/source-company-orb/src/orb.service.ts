import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Orb — Usage-based billing infrastructure platform for software companies.
 *
 * Orb provides billing infrastructure that ingests real-time usage data and
 * translates pricing models into accurate invoices and reporting. It
 * supports usage-based, subscription, and hybrid pricing for software
 * businesses.
 *
 * Sector: Billing infrastructure / Developer platform. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `orb`
 * (`https://jobs.ashbyhq.com/orb`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'orb';
const COMPANY_NAME = 'Orb';

@SourcePlugin({
  site: Site.ORB,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OrbService implements IScraper {
  private readonly logger = new Logger(OrbService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Orb',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Orb: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ORB;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'orb-');
      }
    }

    this.logger.log(`Orb: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
