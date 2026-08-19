import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Rowan — Ear-piercing and jewelry retailer with studios staffed by licensed nurses.
 *
 * Rowan is a retailer offering ear piercing performed by licensed nurses
 * along with a line of jewelry sold online and through its studios. It
 * operates retail studio locations across multiple US states.
 *
 * Sector: Retail / Consumer. HQ: Larchmont, New York, USA.
 *
 * Source: Lever job board, company slug `heyrowan`
 * (`https://jobs.lever.co/heyrowan`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'heyrowan';
const COMPANY_NAME = 'Rowan';

@SourcePlugin({
  site: Site.ROWAN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RowanService implements IScraper {
  private readonly logger = new Logger(RowanService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Rowan',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Rowan: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ROWAN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'heyrowan-');
      }
    }

    this.logger.log(`Rowan: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
