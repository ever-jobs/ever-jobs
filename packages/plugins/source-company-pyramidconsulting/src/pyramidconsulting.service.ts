import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pyramid Consulting — IT consulting services company specializing in staff augmentation and application services.
 *
 * Pyramid Consulting is an information technology consulting services
 * company providing staff augmentation, application development and support,
 * testing and IT solutions. It places technology professionals with
 * enterprise clients.
 *
 * Sector: IT consulting and staffing. HQ: Alpharetta, Georgia, United States.
 *
 * Source: SmartRecruiters job board, company identifier `PyramidIT1`
 * (`https://jobs.smartrecruiters.com/PyramidIT1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PyramidIT1';
const COMPANY_NAME = 'Pyramid Consulting';

@SourcePlugin({
  site: Site.PYRAMID_CONSULTING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PyramidConsultingService implements IScraper {
  private readonly logger = new Logger(PyramidConsultingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Pyramid Consulting',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pyramid Consulting: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PYRAMID_CONSULTING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'pyramidconsulting-');
      }
    }

    this.logger.log(`Pyramid Consulting: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
