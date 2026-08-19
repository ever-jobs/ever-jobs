import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Modal — Serverless cloud platform for AI and data workloads.
 *
 * Modal provides a serverless compute platform that lets developers run AI,
 * machine-learning, and data workloads in the cloud, including GPU-backed
 * jobs, defined in Python.
 *
 * Sector: AI infrastructure / compute. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `modal`
 * (`https://jobs.ashbyhq.com/modal`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'modal';
const COMPANY_NAME = 'Modal';

@SourcePlugin({
  site: Site.MODAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ModalService implements IScraper {
  private readonly logger = new Logger(ModalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Modal',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Modal: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MODAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'modal-');
      }
    }

    this.logger.log(`Modal: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
