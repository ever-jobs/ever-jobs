import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * StudyPoint — Private tutoring and test-preparation company.
 *
 * StudyPoint is a private tutoring company providing one-on-one test
 * preparation and academic tutoring, both in-person and online, across
 * multiple US markets.
 *
 * Sector: education. HQ: Boston, Massachusetts, United States.
 *
 * Source: Lever job board, company slug `studypoint`
 * (`https://jobs.lever.co/studypoint`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'studypoint';
const COMPANY_NAME = 'StudyPoint';

@SourcePlugin({
  site: Site.STUDYPOINT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StudyPointService implements IScraper {
  private readonly logger = new Logger(StudyPointService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape StudyPoint',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `StudyPoint: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STUDYPOINT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'studypoint-');
      }
    }

    this.logger.log(`StudyPoint: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
