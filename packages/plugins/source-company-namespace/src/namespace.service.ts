import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Namespace — Cloud infrastructure platform for fast builds, tests, and CI workloads.
 *
 * Namespace provides cloud compute infrastructure optimized for continuous
 * integration, builds, and test workloads, including fast runners and
 * caching. It offers on-demand machines to accelerate development pipelines.
 *
 * Sector: Developer infrastructure / CI compute. HQ: Zurich, Switzerland.
 *
 * Source: Ashby job board, company slug `namespace`
 * (`https://jobs.ashbyhq.com/namespace`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'namespace';
const COMPANY_NAME = 'Namespace';

@SourcePlugin({
  site: Site.NAMESPACE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NamespaceService implements IScraper {
  private readonly logger = new Logger(NamespaceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Namespace',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Namespace: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NAMESPACE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'namespace-');
      }
    }

    this.logger.log(`Namespace: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
