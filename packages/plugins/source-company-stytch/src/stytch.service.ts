import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Stytch — Authentication and identity platform for developers.
 *
 * Stytch provides authentication and identity APIs and SDKs that developers
 * use to build sign-in, passwordless login, and fraud-prevention features
 * into their applications. It focuses on developer-friendly identity
 * infrastructure.
 *
 * Sector: Authentication & Identity. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `stytch`
 * (`https://jobs.ashbyhq.com/stytch`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'stytch';
const COMPANY_NAME = 'Stytch';

@SourcePlugin({
  site: Site.STYTCH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StytchService implements IScraper {
  private readonly logger = new Logger(StytchService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Stytch',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Stytch: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STYTCH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'stytch-');
      }
    }

    this.logger.log(`Stytch: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
