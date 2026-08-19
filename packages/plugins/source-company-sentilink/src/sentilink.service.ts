import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SentiLink — Provides real-time identity verification and fraud-detection APIs, primarily for financial institutions.
 *
 * SentiLink builds identity and risk solutions that help institutions verify
 * identities and detect synthetic identity fraud in real time. Its APIs are
 * used across financial services and are expanding into additional markets.
 * The company is backed by investors including Craft Ventures, Andreessen
 * Horowitz, and NYCA.
 *
 * Sector: Fraud & Identity. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `sentilink`
 * (`https://jobs.ashbyhq.com/sentilink`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sentilink';
const COMPANY_NAME = 'SentiLink';

@SourcePlugin({
  site: Site.SENTILINK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SentiLinkService implements IScraper {
  private readonly logger = new Logger(SentiLinkService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape SentiLink',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `SentiLink: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SENTILINK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sentilink-');
      }
    }

    this.logger.log(`SentiLink: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
