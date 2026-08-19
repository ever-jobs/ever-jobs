import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Aircall — Cloud-based phone and customer communications platform for businesses.
 *
 * Aircall provides a cloud telephony and customer communications platform
 * that integrates with CRM and helpdesk tools for sales and support teams.
 * It operates offices across Europe, the US, and Australia.
 *
 * Sector: B2B SaaS / Cloud Communications. HQ: Paris, Ile-de-France, France.
 *
 * Source: Lever job board, company slug `aircall`
 * (`https://jobs.lever.co/aircall`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'aircall';
const COMPANY_NAME = 'Aircall';

@SourcePlugin({
  site: Site.AIRCALL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AircallService implements IScraper {
  private readonly logger = new Logger(AircallService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Aircall',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Aircall: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AIRCALL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'aircall-');
      }
    }

    this.logger.log(`Aircall: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
