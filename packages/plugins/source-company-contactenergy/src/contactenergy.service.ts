import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Contact Energy — One of New Zealand\'s largest electricity generators and retailers, with a large geothermal and hydro portfolio.
 *
 * Contact Energy is a New Zealand electricity and natural gas company that
 * generates and retails energy. It operates geothermal, hydro and thermal
 * generation and is one of the country's largest listed companies,
 * positioned around decarbonisation of the NZ grid.
 *
 * Sector: Energy Utility. HQ: Wellington, Wellington, New Zealand.
 *
 * Source: SmartRecruiters job board, company identifier `ContactEnergy`
 * (`https://jobs.smartrecruiters.com/ContactEnergy`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ContactEnergy';
const COMPANY_NAME = 'Contact Energy';

@SourcePlugin({
  site: Site.CONTACT_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ContactEnergyService implements IScraper {
  private readonly logger = new Logger(ContactEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Contact Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Contact Energy: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONTACT_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'contactenergy-');
      }
    }

    this.logger.log(`Contact Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
