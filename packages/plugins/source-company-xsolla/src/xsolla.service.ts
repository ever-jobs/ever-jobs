import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Xsolla — Video game commerce company providing payment and monetization tools for developers.
 *
 * Xsolla provides commerce, payment and monetization tools for video game
 * developers and publishers. It operates globally with teams in multiple
 * regions.
 *
 * Sector: gaming. HQ: Los Angeles, California, United States.
 *
 * Source: Lever job board, company slug `xsolla`
 * (`https://jobs.lever.co/xsolla`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'xsolla';
const COMPANY_NAME = 'Xsolla';

@SourcePlugin({
  site: Site.XSOLLA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class XsollaService implements IScraper {
  private readonly logger = new Logger(XsollaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Xsolla',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Xsolla: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.XSOLLA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'xsolla-');
      }
    }

    this.logger.log(`Xsolla: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
