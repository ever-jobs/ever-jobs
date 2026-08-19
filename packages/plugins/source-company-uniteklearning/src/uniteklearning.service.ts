import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Unitek Learning — Network of nursing and healthcare-focused vocational schools across several U.S. states.
 *
 * Unitek Learning is a healthcare education provider operating a network of
 * schools and colleges across multiple U.S. states. It offers nursing and
 * allied-health programs, including practical nursing, registered nursing,
 * and medical assisting, through campus-based and blended learning formats.
 *
 * Sector: Education (healthcare / vocational education). HQ: Draper, Utah, USA.
 *
 * Source: SmartRecruiters job board, company identifier `UnitekLearning`
 * (`https://jobs.smartrecruiters.com/UnitekLearning`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'UnitekLearning';
const COMPANY_NAME = 'Unitek Learning';

@SourcePlugin({
  site: Site.UNITEK_LEARNING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UnitekLearningService implements IScraper {
  private readonly logger = new Logger(UnitekLearningService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Unitek Learning',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Unitek Learning: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UNITEK_LEARNING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'uniteklearning-');
      }
    }

    this.logger.log(`Unitek Learning: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
