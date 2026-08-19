import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Field Nation — Marketplace and workforce management platform connecting businesses with field service technicians.
 *
 * Field Nation operates a SaaS platform and labor marketplace that connects
 * companies needing on-site IT and field service work with independent
 * technicians, plus tools to manage that workforce. It has teams in
 * Minnesota and Dhaka.
 *
 * Sector: B2B SaaS / Field Service Management. HQ: Minneapolis, Minnesota, United States.
 *
 * Source: Lever job board, company slug `fieldnation`
 * (`https://jobs.lever.co/fieldnation`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'fieldnation';
const COMPANY_NAME = 'Field Nation';

@SourcePlugin({
  site: Site.FIELD_NATION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FieldNationService implements IScraper {
  private readonly logger = new Logger(FieldNationService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Field Nation',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Field Nation: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIELD_NATION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'fieldnation-');
      }
    }

    this.logger.log(`Field Nation: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
