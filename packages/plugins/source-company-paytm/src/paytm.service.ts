import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Paytm — India\'s mobile payments and financial-services distribution platform.
 *
 * Paytm is an Indian digital payments and financial-services company
 * offering mobile wallet, UPI payments, merchant services, and
 * financial-product distribution to consumers and businesses.
 *
 * Sector: Payments / Fintech. HQ: Noida, Uttar Pradesh, India.
 *
 * Source: Lever job board, company slug `paytm`
 * (`https://jobs.lever.co/paytm`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'paytm';
const COMPANY_NAME = 'Paytm';

@SourcePlugin({
  site: Site.PAYTM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PaytmService implements IScraper {
  private readonly logger = new Logger(PaytmService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Paytm',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Paytm: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PAYTM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'paytm-');
      }
    }

    this.logger.log(`Paytm: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
