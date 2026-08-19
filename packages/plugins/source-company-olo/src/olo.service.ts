import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Olo — SaaS platform for restaurant digital ordering, payments, and guest engagement.
 *
 * Olo is a cloud-based platform that provides digital ordering, delivery
 * enablement, payment processing, and guest engagement tools to restaurant
 * brands. It is publicly traded and serves large restaurant chains.
 *
 * Sector: B2B SaaS / Restaurant Technology. HQ: New York, New York, United States.
 *
 * Source: Lever job board, company slug `olo`
 * (`https://jobs.lever.co/olo`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'olo';
const COMPANY_NAME = 'Olo';

@SourcePlugin({
  site: Site.OLO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OloService implements IScraper {
  private readonly logger = new Logger(OloService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Olo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Olo: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OLO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'olo-');
      }
    }

    this.logger.log(`Olo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
