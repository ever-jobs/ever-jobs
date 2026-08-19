import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * MoonPay — Payments platform for buying, selling, and paying in digital currencies.
 *
 * MoonPay operates a payments infrastructure platform that lets consumers
 * and businesses buy, sell, swap, and pay in digital currencies. It is
 * licensed in the US and regulated across the UK, EU, Canada, and Australia.
 *
 * Sector: Crypto Payments. HQ: New York, New York, United States.
 *
 * Source: Lever job board, company slug `moonpay`
 * (`https://jobs.lever.co/moonpay`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'moonpay';
const COMPANY_NAME = 'MoonPay';

@SourcePlugin({
  site: Site.MOONPAY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MoonPayService implements IScraper {
  private readonly logger = new Logger(MoonPayService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape MoonPay',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `MoonPay: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MOONPAY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'moonpay-');
      }
    }

    this.logger.log(`MoonPay: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
