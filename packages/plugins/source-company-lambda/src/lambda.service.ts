import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lambda — GPU cloud and hardware for AI training and inference.
 *
 * Lambda provides GPU cloud services and hardware systems for training and
 * running machine-learning models. It offers cloud instances, clusters, and
 * on-premise GPU systems.
 *
 * Sector: AI infrastructure / GPU cloud. HQ: San Jose, California, USA.
 *
 * Source: Ashby job board, company slug `lambda`
 * (`https://jobs.ashbyhq.com/lambda`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lambda';
const COMPANY_NAME = 'Lambda';

@SourcePlugin({
  site: Site.LAMBDA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LambdaService implements IScraper {
  private readonly logger = new Logger(LambdaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Lambda',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lambda: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LAMBDA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'lambda-');
      }
    }

    this.logger.log(`Lambda: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
