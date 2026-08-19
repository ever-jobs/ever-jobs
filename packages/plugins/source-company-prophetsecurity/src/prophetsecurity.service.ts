import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Prophet Security — AI-driven platform that automates security operations and alert investigation.
 *
 * Prophet Security builds a platform that automates complex security
 * operations tasks such as investigating and triaging security alerts. It is
 * aimed at helping security teams respond faster to potential threats.
 *
 * Sector: Security Operations. HQ: Palo Alto, California, United States.
 *
 * Source: Ashby job board, company slug `prophet-security`
 * (`https://jobs.ashbyhq.com/prophet-security`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'prophet-security';
const COMPANY_NAME = 'Prophet Security';

@SourcePlugin({
  site: Site.PROPHET_SECURITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ProphetSecurityService implements IScraper {
  private readonly logger = new Logger(ProphetSecurityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Prophet Security',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Prophet Security: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PROPHET_SECURITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'prophetsecurity-');
      }
    }

    this.logger.log(`Prophet Security: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
