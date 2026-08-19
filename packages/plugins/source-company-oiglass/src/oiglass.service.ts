import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * O-I Glass — Manufacturer of glass containers for food and beverage brands worldwide.
 *
 * O-I Glass (Owens-Illinois) is a US-headquartered manufacturer of glass
 * packaging for the food and beverage industries. It produces glass bottles
 * and jars for beer, wine, spirits, and food brands globally. The company is
 * publicly traded and operates plants across multiple continents.
 *
 * Sector: Consumer goods packaging (glass). HQ: Perrysburg, Ohio, USA.
 *
 * Source: SmartRecruiters job board, company identifier `O-I`
 * (`https://jobs.smartrecruiters.com/O-I`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'O-I';
const COMPANY_NAME = 'O-I Glass';

@SourcePlugin({
  site: Site.O_I_GLASS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OIGlassService implements IScraper {
  private readonly logger = new Logger(OIGlassService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape O-I Glass',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `O-I Glass: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.O_I_GLASS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'oiglass-');
      }
    }

    this.logger.log(`O-I Glass: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
