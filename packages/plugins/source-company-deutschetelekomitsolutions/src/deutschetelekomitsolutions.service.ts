import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deutsche Telekom IT Solutions — IT services and solutions arm of Deutsche Telekom.
 *
 * Deutsche Telekom IT Solutions provides IT services, software development,
 * and infrastructure operations within the Deutsche Telekom group. It
 * delivers cloud, network, and enterprise IT solutions across Europe. It
 * operates large technology delivery centers.
 *
 * Sector: IT services and enterprise technology. HQ: Budapest, Hungary.
 *
 * Source: SmartRecruiters job board, company identifier `deutschetelekomitsolutions`
 * (`https://jobs.smartrecruiters.com/deutschetelekomitsolutions`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'deutschetelekomitsolutions';
const COMPANY_NAME = 'Deutsche Telekom IT Solutions';

@SourcePlugin({
  site: Site.DEUTSCHE_TELEKOM_IT_SOLUTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeutscheTelekomITSolutionsService implements IScraper {
  private readonly logger = new Logger(DeutscheTelekomITSolutionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Deutsche Telekom IT Solutions',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deutsche Telekom IT Solutions: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEUTSCHE_TELEKOM_IT_SOLUTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deutschetelekomitsolutions-');
      }
    }

    this.logger.log(`Deutsche Telekom IT Solutions: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
