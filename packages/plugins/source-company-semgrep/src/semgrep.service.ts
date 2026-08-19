import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Semgrep — Code and application security platform built on static analysis.
 *
 * Semgrep develops a static-analysis-based platform for application
 * security, enabling teams to scan code for security vulnerabilities and
 * enforce secure coding standards. It offers both open-source and commercial
 * products for developers and security teams.
 *
 * Sector: Application Security. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `semgrep`
 * (`https://jobs.ashbyhq.com/semgrep`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'semgrep';
const COMPANY_NAME = 'Semgrep';

@SourcePlugin({
  site: Site.SEMGREP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SemgrepService implements IScraper {
  private readonly logger = new Logger(SemgrepService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Semgrep',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Semgrep: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SEMGREP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'semgrep-');
      }
    }

    this.logger.log(`Semgrep: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
