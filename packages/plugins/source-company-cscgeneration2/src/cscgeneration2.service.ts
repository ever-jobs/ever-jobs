import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CSC Generation — Holding company that acquires and operates retail and e-commerce brands.
 *
 * CSC Generation is a holding company that acquires established retail and
 * direct-to-consumer brands and operates them, including Sur La Table and
 * Backcountry. It runs distribution centers and retail operations across the
 * US.
 *
 * Sector: Retail / E-commerce. HQ: Merrillville, Indiana, USA.
 *
 * Source: Lever job board, company slug `cscgeneration-2`
 * (`https://jobs.lever.co/cscgeneration-2`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cscgeneration-2';
const COMPANY_NAME = 'CSC Generation';

@SourcePlugin({
  site: Site.CSC_GENERATION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CSCGenerationService implements IScraper {
  private readonly logger = new Logger(CSCGenerationService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape CSC Generation',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `CSC Generation: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CSC_GENERATION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'cscgeneration2-');
      }
    }

    this.logger.log(`CSC Generation: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
