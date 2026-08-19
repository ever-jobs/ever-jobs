import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Smiths Group — Diversified industrial technology company engineering products for energy, safety, and general industrial markets.
 *
 * Smiths Group plc is a British multinational engineering company. It
 * designs and manufactures products across divisions including John Crane
 * (mechanical seals and flow control), Smiths Detection, Flex-Tek, and
 * Smiths Interconnect, serving energy, industrial, and security markets.
 *
 * Sector: Industrial technology / Engineering. HQ: London, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `SmithsGroup2`
 * (`https://jobs.smartrecruiters.com/SmithsGroup2`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SmithsGroup2';
const COMPANY_NAME = 'Smiths Group';

@SourcePlugin({
  site: Site.SMITHS_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SmithsGroupService implements IScraper {
  private readonly logger = new Logger(SmithsGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Smiths Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Smiths Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SMITHS_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'smithsgroup-');
      }
    }

    this.logger.log(`Smiths Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
