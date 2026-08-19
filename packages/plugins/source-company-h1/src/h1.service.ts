import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * H1 — Healthcare data platform connecting information on physicians, researchers, and clinical trials.
 *
 * H1 operates a healthcare data platform that aggregates information about
 * healthcare professionals, clinical research, and trials to support
 * life-sciences commercial, medical, and clinical-operations teams.
 *
 * Sector: Health Tech / Data. HQ: New York, New York, USA.
 *
 * Source: Lever job board, company slug `h1`
 * (`https://jobs.lever.co/h1`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'h1';
const COMPANY_NAME = 'H1';

@SourcePlugin({
  site: Site.H1,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class H1Service implements IScraper {
  private readonly logger = new Logger(H1Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape H1',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `H1: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.H1;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'h1-');
      }
    }

    this.logger.log(`H1: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
