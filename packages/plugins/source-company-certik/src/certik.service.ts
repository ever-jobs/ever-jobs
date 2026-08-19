import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CertiK — Blockchain security firm providing smart-contract audits and Web3 security monitoring.
 *
 * CertiK is a blockchain security company founded in 2018 that audits smart
 * contracts and blockchain protocols, conducts security research, and
 * provides monitoring and compliance tooling for Web3 projects.
 *
 * Sector: Blockchain Security. HQ: New York, New York, United States.
 *
 * Source: Lever job board, company slug `certik`
 * (`https://jobs.lever.co/certik`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'certik';
const COMPANY_NAME = 'CertiK';

@SourcePlugin({
  site: Site.CERTIK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CertiKService implements IScraper {
  private readonly logger = new Logger(CertiKService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape CertiK',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `CertiK: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CERTIK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'certik-');
      }
    }

    this.logger.log(`CertiK: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
