import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Blockstream — Builds Bitcoin infrastructure including the Liquid Network and Lightning tooling.
 *
 * Blockstream builds infrastructure and products on the Bitcoin protocol.
 * Its work spans layer-2 projects such as the Liquid Network and Core
 * Lightning, along with end-user software and hardware wallets. The company
 * focuses on foundational Bitcoin technology.
 *
 * Sector: Bitcoin infrastructure. HQ: Victoria, British Columbia, Canada.
 *
 * Source: Ashby job board, company slug `blockstream`
 * (`https://jobs.ashbyhq.com/blockstream`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'blockstream';
const COMPANY_NAME = 'Blockstream';

@SourcePlugin({
  site: Site.BLOCKSTREAM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BlockstreamService implements IScraper {
  private readonly logger = new Logger(BlockstreamService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Blockstream',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Blockstream: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BLOCKSTREAM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'blockstream-');
      }
    }

    this.logger.log(`Blockstream: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
