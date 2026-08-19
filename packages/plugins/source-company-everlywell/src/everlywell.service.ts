import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Everlywell — Consumer digital health company offering at-home lab testing and telehealth services.
 *
 * Everlywell provides at-home laboratory test kits, digital results, and
 * connected telehealth care across consumer and enterprise channels. It
 * operates under the Everly Health umbrella spanning consumer, enterprise,
 * and diagnostics lines.
 *
 * Sector: Digital Health. HQ: Austin, Texas, USA.
 *
 * Source: Lever job board, company slug `everlywell`
 * (`https://jobs.lever.co/everlywell`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'everlywell';
const COMPANY_NAME = 'Everlywell';

@SourcePlugin({
  site: Site.EVERLYWELL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EverlywellService implements IScraper {
  private readonly logger = new Logger(EverlywellService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Everlywell',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Everlywell: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EVERLYWELL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'everlywell-');
      }
    }

    this.logger.log(`Everlywell: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
