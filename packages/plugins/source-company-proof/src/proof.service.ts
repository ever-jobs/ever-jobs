import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Proof — Identity-assured transaction management platform for verifying identity and preventing fraud in high-value transactions.
 *
 * Proof provides an identity-assured transaction management platform that
 * verifies identities and secures online transactions such as real estate
 * closings, mortgage approvals, and auto sales, with the goal of
 * establishing digital trust and preventing fraud.
 *
 * Sector: Cybersecurity / Fraud Prevention (Identity Verification). HQ: Austin, Texas, United States.
 *
 * Source: Lever job board, company slug `proof`
 * (`https://jobs.lever.co/proof`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'proof';
const COMPANY_NAME = 'Proof';

@SourcePlugin({
  site: Site.PROOF,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ProofService implements IScraper {
  private readonly logger = new Logger(ProofService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Proof',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Proof: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PROOF;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'proof-');
      }
    }

    this.logger.log(`Proof: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
