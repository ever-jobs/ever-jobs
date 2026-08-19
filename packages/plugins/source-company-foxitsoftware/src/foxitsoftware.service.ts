import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Foxit — PDF and document productivity software for individuals and enterprises.
 *
 * Foxit develops PDF editing, e-signature, and document management software
 * for businesses and consumers. It operates internationally with teams in
 * the US and Ireland.
 *
 * Sector: B2B SaaS / Document Productivity. HQ: Fremont, California, United States.
 *
 * Source: Lever job board, company slug `foxitsoftware`
 * (`https://jobs.lever.co/foxitsoftware`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'foxitsoftware';
const COMPANY_NAME = 'Foxit';

@SourcePlugin({
  site: Site.FOXIT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FoxitService implements IScraper {
  private readonly logger = new Logger(FoxitService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Foxit',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Foxit: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FOXIT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'foxitsoftware-');
      }
    }

    this.logger.log(`Foxit: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
