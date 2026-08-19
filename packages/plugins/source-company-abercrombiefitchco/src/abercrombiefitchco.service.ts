import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Abercrombie & Fitch Co. — Global specialty apparel retailer operating multiple clothing brands.
 *
 * Abercrombie & Fitch Co. is a US-based specialty apparel retailer that
 * designs and sells clothing and accessories for men, women, and kids. Its
 * portfolio includes the Abercrombie & Fitch, Hollister, abercrombie kids,
 * and Gilly Hicks brands. The company sells through physical stores and
 * e-commerce globally.
 *
 * Sector: Apparel retail (specialty). HQ: New Albany, Ohio, USA.
 *
 * Source: SmartRecruiters job board, company identifier `AbercrombieAndFitchCo`
 * (`https://jobs.smartrecruiters.com/AbercrombieAndFitchCo`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AbercrombieAndFitchCo';
const COMPANY_NAME = 'Abercrombie & Fitch Co.';

@SourcePlugin({
  site: Site.ABERCROMBIE_FITCH_CO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AbercrombieFitchCoService implements IScraper {
  private readonly logger = new Logger(AbercrombieFitchCoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Abercrombie & Fitch Co.',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Abercrombie & Fitch Co.: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ABERCROMBIE_FITCH_CO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'abercrombiefitchco-');
      }
    }

    this.logger.log(`Abercrombie & Fitch Co.: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
