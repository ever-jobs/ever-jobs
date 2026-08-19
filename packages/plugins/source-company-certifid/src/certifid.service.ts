import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CertifID — Wire fraud prevention and identity verification platform for real estate and title transactions.
 *
 * CertifID provides identity verification and wire fraud prevention for real
 * estate transactions, helping title companies, law firms, lenders, and
 * consumers verify identities and authenticate wire transfer instructions to
 * prevent fraudulent payments.
 *
 * Sector: Cybersecurity / Fraud Prevention (Identity Verification). HQ: Austin, Texas, United States.
 *
 * Source: Lever job board, company slug `certifid`
 * (`https://jobs.lever.co/certifid`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'certifid';
const COMPANY_NAME = 'CertifID';

@SourcePlugin({
  site: Site.CERTIFID,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CertifIDService implements IScraper {
  private readonly logger = new Logger(CertifIDService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape CertifID',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `CertifID: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CERTIFID;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'certifid-');
      }
    }

    this.logger.log(`CertifID: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
