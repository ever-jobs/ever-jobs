import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Finary — A personal finance and wealth management app for tracking investments and net worth.
 *
 * Finary is a personal finance application that lets users track
 * investments, budgets, and net worth in real time, linking banks, brokers,
 * crypto platforms, and real estate. It provides performance reports,
 * dividend tracking, and fee analysis.
 *
 * Sector: Fintech - Personal finance & wealth tracking. HQ: Paris, France.
 *
 * Source: Ashby job board, company slug `finary`
 * (`https://jobs.ashbyhq.com/finary`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'finary';
const COMPANY_NAME = 'Finary';

@SourcePlugin({
  site: Site.FINARY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FinaryService implements IScraper {
  private readonly logger = new Logger(FinaryService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Finary',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Finary: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FINARY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'finary-');
      }
    }

    this.logger.log(`Finary: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
