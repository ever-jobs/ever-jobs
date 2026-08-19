import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Baseten — Infrastructure for deploying and serving machine-learning models.
 *
 * Baseten provides infrastructure for deploying, serving, and scaling
 * machine-learning and large language models in production. It targets
 * developers and companies running model inference.
 *
 * Sector: AI infrastructure / model serving. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `baseten`
 * (`https://jobs.ashbyhq.com/baseten`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'baseten';
const COMPANY_NAME = 'Baseten';

@SourcePlugin({
  site: Site.BASETEN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BasetenService implements IScraper {
  private readonly logger = new Logger(BasetenService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Baseten',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Baseten: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BASETEN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'baseten-');
      }
    }

    this.logger.log(`Baseten: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
