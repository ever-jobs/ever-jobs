import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lendable — A technology-driven lending platform using AI to automate credit decisions.
 *
 * Lendable is a lending business that uses technology and AI to automate
 * credit decisions, originating and servicing loans funded by institutional
 * investors. It operates a consumer lending platform and provides debt
 * finance to fintechs.
 *
 * Sector: Fintech - Lending. HQ: London, UK.
 *
 * Source: Ashby job board, company slug `lendable`
 * (`https://jobs.ashbyhq.com/lendable`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lendable';
const COMPANY_NAME = 'Lendable';

@SourcePlugin({
  site: Site.LENDABLE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LendableService implements IScraper {
  private readonly logger = new Logger(LendableService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Lendable',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lendable: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LENDABLE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'lendable-');
      }
    }

    this.logger.log(`Lendable: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
