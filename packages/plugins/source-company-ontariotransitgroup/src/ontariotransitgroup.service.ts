import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ontario Transit Group — Consortium delivering the Ontario Line subway project in Toronto.
 *
 * Ontario Transit Group is a consortium involved in the design,
 * construction, and delivery of the Ontario Line subway expansion in
 * Toronto. It recruits for engineering, construction, and rail transit
 * project roles.
 *
 * Sector: Transportation & Public Transit. HQ: Toronto, Ontario, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `OntarioTransitGroup`
 * (`https://jobs.smartrecruiters.com/OntarioTransitGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'OntarioTransitGroup';
const COMPANY_NAME = 'Ontario Transit Group';

@SourcePlugin({
  site: Site.ONTARIO_TRANSIT_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OntarioTransitGroupService implements IScraper {
  private readonly logger = new Logger(OntarioTransitGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Ontario Transit Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ontario Transit Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ONTARIO_TRANSIT_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'ontariotransitgroup-');
      }
    }

    this.logger.log(`Ontario Transit Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
