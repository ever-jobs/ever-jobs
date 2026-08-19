import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * vTech Solution — IT staffing and managed services provider serving government and commercial clients.
 *
 * vTech Solution is an IT staffing and managed services company that places
 * technology professionals and delivers infrastructure and support services.
 * It serves government agencies and commercial organizations across the
 * United States.
 *
 * Sector: IT staffing and services. HQ: Washington, D.C., United States.
 *
 * Source: SmartRecruiters job board, company identifier `VTechSolution1`
 * (`https://jobs.smartrecruiters.com/VTechSolution1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'VTechSolution1';
const COMPANY_NAME = 'vTech Solution';

@SourcePlugin({
  site: Site.VTECH_SOLUTION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VTechSolutionService implements IScraper {
  private readonly logger = new Logger(VTechSolutionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape vTech Solution',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `vTech Solution: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VTECH_SOLUTION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'vtechsolution-');
      }
    }

    this.logger.log(`vTech Solution: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
