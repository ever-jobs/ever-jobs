import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Qualified Health — Builds a governed generative AI platform for healthcare organizations.
 *
 * Qualified Health is a public benefit corporation building a generative AI
 * platform designed for healthcare systems, with an emphasis on governance
 * and safe deployment. It works with health systems to integrate AI into
 * clinical and operational workflows. The company is structured as a PBC.
 *
 * Sector: Healthtech (healthcare AI). HQ: United States.
 *
 * Source: Ashby job board, company slug `qualified-health-pbc`
 * (`https://jobs.ashbyhq.com/qualified-health-pbc`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'qualified-health-pbc';
const COMPANY_NAME = 'Qualified Health';

@SourcePlugin({
  site: Site.QUALIFIED_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class QualifiedHealthService implements IScraper {
  private readonly logger = new Logger(QualifiedHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Qualified Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Qualified Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.QUALIFIED_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'qualifiedhealth-');
      }
    }

    this.logger.log(`Qualified Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
