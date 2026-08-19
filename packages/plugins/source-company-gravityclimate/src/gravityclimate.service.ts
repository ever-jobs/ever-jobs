import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gravity Climate — Provides software for industrial companies to measure and manage carbon emissions and energy use.
 *
 * Gravity Climate builds software that helps industrial businesses and their
 * partners measure, track, and manage greenhouse gas emissions and energy
 * data. The platform is aimed at carbon accounting and decarbonization
 * planning for industrial operations. The company is based in San Francisco.
 *
 * Sector: Carbon / energy management software. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `gravityclimate`
 * (`https://jobs.ashbyhq.com/gravityclimate`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gravityclimate';
const COMPANY_NAME = 'Gravity Climate';

@SourcePlugin({
  site: Site.GRAVITY_CLIMATE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GravityClimateService implements IScraper {
  private readonly logger = new Logger(GravityClimateService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Gravity Climate',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gravity Climate: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GRAVITY_CLIMATE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'gravityclimate-');
      }
    }

    this.logger.log(`Gravity Climate: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
