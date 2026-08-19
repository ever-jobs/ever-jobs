import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cohere — Builds large language models and AI infrastructure for enterprises.
 *
 * Cohere develops large language models and related tooling aimed at
 * enterprise use cases such as search, retrieval, and generation. It
 * provides its models through an API and offers deployment options for
 * businesses.
 *
 * Sector: AI foundation-model lab. HQ: Toronto, Ontario, Canada.
 *
 * Source: Ashby job board, company slug `cohere`
 * (`https://jobs.ashbyhq.com/cohere`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cohere';
const COMPANY_NAME = 'Cohere';

@SourcePlugin({
  site: Site.COHERE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CohereService implements IScraper {
  private readonly logger = new Logger(CohereService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Cohere',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cohere: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COHERE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'cohere-');
      }
    }

    this.logger.log(`Cohere: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
