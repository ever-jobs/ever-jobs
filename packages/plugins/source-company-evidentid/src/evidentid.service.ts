import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Evident — Enterprise platform, accessible via web portal or API, for automated third-party insurance and credential verification.
 *
 * Evident provides a privacy-first enterprise platform, available via web
 * portal or API, for automating third-party insurance verification and
 * credential management, monitoring, and compliance. It is a VC-backed
 * technology company.
 *
 * Sector: Identity / verification API platform. HQ: Atlanta, Georgia, United States.
 *
 * Source: Lever job board, company slug `evidentid`
 * (`https://jobs.lever.co/evidentid`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'evidentid';
const COMPANY_NAME = 'Evident';

@SourcePlugin({
  site: Site.EVIDENT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EvidentService implements IScraper {
  private readonly logger = new Logger(EvidentService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Evident',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Evident: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EVIDENT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'evidentid-');
      }
    }

    this.logger.log(`Evident: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
