import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * KIPP SoCal Public Schools — Network of tuition-free public charter schools in Southern California.
 *
 * KIPP SoCal Public Schools operates a network of tuition-free,
 * open-enrollment public charter schools across Southern California, hiring
 * teachers and program staff.
 *
 * Sector: education. HQ: Los Angeles, California, United States.
 *
 * Source: Lever job board, company slug `kippsocal`
 * (`https://jobs.lever.co/kippsocal`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'kippsocal';
const COMPANY_NAME = 'KIPP SoCal Public Schools';

@SourcePlugin({
  site: Site.KIPP_SOCAL_PUBLIC_SCHOOLS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KIPPSoCalPublicSchoolsService implements IScraper {
  private readonly logger = new Logger(KIPPSoCalPublicSchoolsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape KIPP SoCal Public Schools',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `KIPP SoCal Public Schools: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KIPP_SOCAL_PUBLIC_SCHOOLS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'kippsocal-');
      }
    }

    this.logger.log(`KIPP SoCal Public Schools: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
