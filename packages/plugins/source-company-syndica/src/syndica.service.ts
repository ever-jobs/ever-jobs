import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Syndica — Provides RPC and node infrastructure for the Solana blockchain.
 *
 * Syndica provides blockchain infrastructure, including RPC and node
 * services, primarily for the Solana ecosystem. It supports developers
 * building onchain applications. The company focuses on scalable blockchain
 * infrastructure.
 *
 * Sector: Blockchain infrastructure (Solana). HQ: Remote.
 *
 * Source: Ashby job board, company slug `syndica`
 * (`https://jobs.ashbyhq.com/syndica`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'syndica';
const COMPANY_NAME = 'Syndica';

@SourcePlugin({
  site: Site.SYNDICA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SyndicaService implements IScraper {
  private readonly logger = new Logger(SyndicaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Syndica',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Syndica: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SYNDICA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'syndica-');
      }
    }

    this.logger.log(`Syndica: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
