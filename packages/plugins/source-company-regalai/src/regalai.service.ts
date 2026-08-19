import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Regal — Builds AI voice agents for customer contact and sales operations.
 *
 * Regal builds AI voice agents deployed in production for customer contact,
 * with forward-deployed engineering, product and analytics roles.
 *
 * Sector: Applied AI / voice agents. HQ: New York, New York, USA.
 *
 * Source: Lever job board, company slug `regal.ai`
 * (`https://jobs.lever.co/regal.ai`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'regal.ai';
const COMPANY_NAME = 'Regal';

@SourcePlugin({
  site: Site.REGAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RegalService implements IScraper {
  private readonly logger = new Logger(RegalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Regal',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Regal: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REGAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'regalai-');
      }
    }

    this.logger.log(`Regal: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
