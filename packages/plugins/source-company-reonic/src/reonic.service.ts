import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Reonic — Provides software for solar and heat pump installers to plan and manage residential energy projects.
 *
 * Reonic builds software used by installers of solar systems, battery
 * storage, and heat pumps to plan, quote, and manage residential
 * clean-energy installations. The platform is aimed at streamlining the
 * sales and installation workflow for energy tradespeople. The company is
 * based in Germany.
 *
 * Sector: Solar / clean energy software. HQ: Karlsruhe, Germany.
 *
 * Source: Ashby job board, company slug `reonic`
 * (`https://jobs.ashbyhq.com/reonic`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'reonic';
const COMPANY_NAME = 'Reonic';

@SourcePlugin({
  site: Site.REONIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ReonicService implements IScraper {
  private readonly logger = new Logger(ReonicService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Reonic',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Reonic: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REONIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'reonic-');
      }
    }

    this.logger.log(`Reonic: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
