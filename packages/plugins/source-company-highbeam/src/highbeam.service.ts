import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Highbeam — A banking and finance platform for ecommerce and consumer brands.
 *
 * Highbeam is a finance platform for ecommerce and consumer brands, offering
 * embedded bank accounts and charge cards along with cash-flow management
 * and credit tools. It was founded in 2021 and is based in New York.
 *
 * Sector: Fintech - Business banking. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `highbeam`
 * (`https://jobs.ashbyhq.com/highbeam`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'highbeam';
const COMPANY_NAME = 'Highbeam';

@SourcePlugin({
  site: Site.HIGHBEAM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HighbeamService implements IScraper {
  private readonly logger = new Logger(HighbeamService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Highbeam',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Highbeam: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIGHBEAM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'highbeam-');
      }
    }

    this.logger.log(`Highbeam: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
