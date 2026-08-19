import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * DeleteMe — Privacy protection service that continuously removes exposed personal data from data brokers and the open web.
 *
 * DeleteMe is a privacy-protection service that continuously scans the open
 * web and data brokers to locate and remove individuals' personally
 * identifiable information, reducing exposure to identity theft, phishing,
 * doxxing, and related threats for both consumers and enterprises.
 *
 * Sector: Privacy (Personal Data Removal). HQ: Boston, Massachusetts, United States.
 *
 * Source: Lever job board, company slug `deleteme`
 * (`https://jobs.lever.co/deleteme`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'deleteme';
const COMPANY_NAME = 'DeleteMe';

@SourcePlugin({
  site: Site.DELETEME,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeleteMeService implements IScraper {
  private readonly logger = new Logger(DeleteMeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape DeleteMe',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `DeleteMe: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELETEME;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'deleteme-');
      }
    }

    this.logger.log(`DeleteMe: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
