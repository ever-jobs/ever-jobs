import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Monte Carlo — Data and AI observability platform for detecting data reliability issues.
 *
 * Monte Carlo provides a data and AI observability platform that monitors
 * data pipelines to detect and resolve data reliability issues. The company
 * serves enterprise customers and hires for full-time, remote-eligible roles
 * across sales, support, marketing, and engineering.
 *
 * Sector: Data Observability. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `montecarlodata`
 * (`https://jobs.ashbyhq.com/montecarlodata`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'montecarlodata';
const COMPANY_NAME = 'Monte Carlo';

@SourcePlugin({
  site: Site.MONTE_CARLO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MonteCarloService implements IScraper {
  private readonly logger = new Logger(MonteCarloService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Monte Carlo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Monte Carlo: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MONTE_CARLO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'montecarlo-');
      }
    }

    this.logger.log(`Monte Carlo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
