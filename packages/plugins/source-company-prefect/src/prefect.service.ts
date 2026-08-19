import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Prefect — Workflow orchestration platform for data and machine learning pipelines.
 *
 * Prefect builds a workflow orchestration platform for data and machine
 * learning engineers, enabling the scheduling, execution, and monitoring of
 * Python-based pipelines. It offers an open-source framework and a managed
 * cloud service.
 *
 * Sector: Data infrastructure / Workflow orchestration. HQ: Washington, D.C., USA.
 *
 * Source: Ashby job board, company slug `prefect`
 * (`https://jobs.ashbyhq.com/prefect`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'prefect';
const COMPANY_NAME = 'Prefect';

@SourcePlugin({
  site: Site.PREFECT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PrefectService implements IScraper {
  private readonly logger = new Logger(PrefectService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Prefect',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Prefect: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PREFECT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'prefect-');
      }
    }

    this.logger.log(`Prefect: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
