import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Compa — Compensation data and management software for talent teams.
 *
 * Compa is a compensation-management software company that provides data and
 * tools to help talent and total-rewards teams benchmark and manage pay. It
 * focuses on compensation workflows for recruiting and HR. The company is
 * venture-backed.
 *
 * Sector: B2B SaaS / HR technology. HQ: Los Angeles, California, USA.
 *
 * Source: Ashby job board, company slug `compa`
 * (`https://jobs.ashbyhq.com/compa`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'compa';
const COMPANY_NAME = 'Compa';

@SourcePlugin({
  site: Site.COMPA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CompaService implements IScraper {
  private readonly logger = new Logger(CompaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Compa',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Compa: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COMPA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'compa-');
      }
    }

    this.logger.log(`Compa: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
