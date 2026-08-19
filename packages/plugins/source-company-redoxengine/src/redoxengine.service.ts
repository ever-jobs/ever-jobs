import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Redox — Healthcare data interoperability platform connecting software to health systems.
 *
 * Redox provides an interoperability platform and API that connects digital
 * health applications with electronic health record systems and healthcare
 * organizations. It hires remotely across the United States.
 *
 * Sector: B2B SaaS / Healthcare Technology. HQ: Madison, Wisconsin, United States.
 *
 * Source: Lever job board, company slug `redoxengine`
 * (`https://jobs.lever.co/redoxengine`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'redoxengine';
const COMPANY_NAME = 'Redox';

@SourcePlugin({
  site: Site.REDOX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RedoxService implements IScraper {
  private readonly logger = new Logger(RedoxService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Redox',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Redox: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REDOX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'redoxengine-');
      }
    }

    this.logger.log(`Redox: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
