import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SanDisk — Manufacturer of flash memory storage products including SSDs, memory cards, and USB drives.
 *
 * SanDisk is a manufacturer of flash storage solutions, producing
 * solid-state drives, memory cards, USB flash drives, and embedded storage.
 * It became a standalone company following its separation from Western
 * Digital.
 *
 * Sector: Electronics / Flash memory manufacturing. HQ: Milpitas, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Sandisk`
 * (`https://jobs.smartrecruiters.com/Sandisk`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Sandisk';
const COMPANY_NAME = 'SanDisk';

@SourcePlugin({
  site: Site.SANDISK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SanDiskService implements IScraper {
  private readonly logger = new Logger(SanDiskService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape SanDisk',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `SanDisk: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SANDISK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'sandisk-');
      }
    }

    this.logger.log(`SanDisk: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
