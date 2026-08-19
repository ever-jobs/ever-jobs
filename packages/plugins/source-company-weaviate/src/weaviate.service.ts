import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Weaviate — AI-native open-source vector database for unstructured data.
 *
 * Weaviate develops an open-source, AI-native vector database used to store
 * and search embeddings of unstructured data for machine learning and
 * retrieval applications. It offers a managed cloud service. The company
 * hires across Growth, Product, and Applied Research.
 *
 * Sector: Databases / Vector Database. HQ: Amsterdam, North Holland, Netherlands.
 *
 * Source: Ashby job board, company slug `weaviate`
 * (`https://jobs.ashbyhq.com/weaviate`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'weaviate';
const COMPANY_NAME = 'Weaviate';

@SourcePlugin({
  site: Site.WEAVIATE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WeaviateService implements IScraper {
  private readonly logger = new Logger(WeaviateService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Weaviate',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Weaviate: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WEAVIATE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'weaviate-');
      }
    }

    this.logger.log(`Weaviate: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
