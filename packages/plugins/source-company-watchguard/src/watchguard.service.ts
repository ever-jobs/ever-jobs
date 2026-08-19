import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * WatchGuard Technologies — Provides network security, endpoint protection, identity, SASE, and secure Wi-Fi products.
 *
 * WatchGuard Technologies is a cybersecurity company delivering network
 * security, endpoint protection, identity, SASE, and secure Wi-Fi solutions,
 * largely through managed service providers and partners. It hires
 * engineering and go-to-market roles internationally.
 *
 * Sector: Cloud / network security infrastructure. HQ: Seattle, Washington, United States.
 *
 * Source: Lever job board, company slug `watchguard`
 * (`https://jobs.lever.co/watchguard`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'watchguard';
const COMPANY_NAME = 'WatchGuard Technologies';

@SourcePlugin({
  site: Site.WATCHGUARD_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WatchGuardTechnologiesService implements IScraper {
  private readonly logger = new Logger(WatchGuardTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape WatchGuard Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `WatchGuard Technologies: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WATCHGUARD_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'watchguard-');
      }
    }

    this.logger.log(`WatchGuard Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
