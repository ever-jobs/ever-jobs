import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * OP Labs — Builds the technology behind Optimism and the open-source OP Stack.
 *
 * OP Labs builds the technology behind Optimism, an Ethereum layer-2 scaling
 * ecosystem. Its open-source OP Stack lets developers launch onchain
 * networks. The team works on protocol engineering including proofs and
 * scaling.
 *
 * Sector: Ethereum layer-2 infrastructure. HQ: Remote.
 *
 * Source: Ashby job board, company slug `oplabs`
 * (`https://jobs.ashbyhq.com/oplabs`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'oplabs';
const COMPANY_NAME = 'OP Labs';

@SourcePlugin({
  site: Site.OP_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OPLabsService implements IScraper {
  private readonly logger = new Logger(OPLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape OP Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `OP Labs: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OP_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'oplabs-');
      }
    }

    this.logger.log(`OP Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
