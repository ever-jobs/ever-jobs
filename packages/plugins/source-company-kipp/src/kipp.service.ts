import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * KIPP — National non-profit network of tuition-free, open-enrollment public charter schools.
 *
 * KIPP (Knowledge Is Power Program) is a non-profit network of tuition-free,
 * open-enrollment public charter schools serving students across many U.S.
 * regions. It employs teachers, school leaders, and operational staff to run
 * K-12 college-preparatory schools in underserved communities.
 *
 * Sector: Education (K-12 public charter schools / non-profit). HQ: New York, New York, USA (national office).
 *
 * Source: SmartRecruiters job board, company identifier `KIPP`
 * (`https://jobs.smartrecruiters.com/KIPP`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'KIPP';
const COMPANY_NAME = 'KIPP';

@SourcePlugin({
  site: Site.KIPP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KIPPService implements IScraper {
  private readonly logger = new Logger(KIPPService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape KIPP',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `KIPP: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KIPP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'kipp-');
      }
    }

    this.logger.log(`KIPP: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
