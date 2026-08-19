import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Foundation EGI — Builds geometry and machine-learning foundation technology.
 *
 * Foundation EGI develops machine-learning and geometry foundation
 * technology, hiring ML Ops, data engineering and research-science roles in
 * Boston and remote.
 *
 * Sector: AI / ML infrastructure. HQ: Boston, Massachusetts, USA.
 *
 * Source: Lever job board, company slug `foundation-llm-technologies`
 * (`https://jobs.lever.co/foundation-llm-technologies`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'foundation-llm-technologies';
const COMPANY_NAME = 'Foundation EGI';

@SourcePlugin({
  site: Site.FOUNDATION_EGI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FoundationEGIService implements IScraper {
  private readonly logger = new Logger(FoundationEGIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Foundation EGI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Foundation EGI: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FOUNDATION_EGI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'foundationllmtechnologies-');
      }
    }

    this.logger.log(`Foundation EGI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
