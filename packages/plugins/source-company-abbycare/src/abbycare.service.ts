import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Abby Care — Provides care and support for families of children with complex medical needs.
 *
 * Abby Care builds care programs for families caring for children with
 * disabilities and complex medical needs, including support for family
 * caregivers. It combines technology with clinical and administrative
 * services. The company operates within Medicaid home-care programs.
 *
 * Sector: Healthtech (pediatric / home care). HQ: United States.
 *
 * Source: Ashby job board, company slug `abby-care`
 * (`https://jobs.ashbyhq.com/abby-care`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'abby-care';
const COMPANY_NAME = 'Abby Care';

@SourcePlugin({
  site: Site.ABBY_CARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AbbyCareService implements IScraper {
  private readonly logger = new Logger(AbbyCareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Abby Care',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Abby Care: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ABBY_CARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'abbycare-');
      }
    }

    this.logger.log(`Abby Care: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
