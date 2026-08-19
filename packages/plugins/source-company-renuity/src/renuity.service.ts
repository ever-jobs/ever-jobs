import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Renuity — Home improvement company operating a network of regional home renovation brands.
 *
 * Renuity is a home improvement company that brings together a network of
 * regional brands offering renovation services such as bath, kitchen, and
 * other home upgrades. It markets and sells home improvement products and
 * services to consumers. The company hosts its careers page on Ashby.
 *
 * Sector: Retail / home improvement. HQ: United States.
 *
 * Source: Ashby job board, company slug `renuity`
 * (`https://jobs.ashbyhq.com/renuity`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'renuity';
const COMPANY_NAME = 'Renuity';

@SourcePlugin({
  site: Site.RENUITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RenuityService implements IScraper {
  private readonly logger = new Logger(RenuityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Renuity',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Renuity: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RENUITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'renuity-');
      }
    }

    this.logger.log(`Renuity: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
