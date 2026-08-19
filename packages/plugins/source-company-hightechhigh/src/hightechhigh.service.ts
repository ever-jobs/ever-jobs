import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * High Tech High — Network of public charter schools in San Diego County.
 *
 * High Tech High is a network of public charter schools serving grades K-12
 * across San Diego County, known for project-based learning. It hires
 * teachers across grade levels.
 *
 * Sector: education. HQ: San Diego, California, United States.
 *
 * Source: Lever job board, company slug `hightechhigh`
 * (`https://jobs.lever.co/hightechhigh`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hightechhigh';
const COMPANY_NAME = 'High Tech High';

@SourcePlugin({
  site: Site.HIGH_TECH_HIGH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HighTechHighService implements IScraper {
  private readonly logger = new Logger(HighTechHighService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape High Tech High',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `High Tech High: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIGH_TECH_HIGH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'hightechhigh-');
      }
    }

    this.logger.log(`High Tech High: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
