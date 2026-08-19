import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * benuta — E-commerce retailer of rugs and home textiles selling across Europe via its own online shops.
 *
 * benuta GmbH is a German e-commerce company selling rugs and home textiles
 * online across multiple European countries, with teams in the Bonn/Cologne
 * region. Its Recruitee board (benutagmbh.recruitee.com) returned a JSON
 * offers array including roles such as 'Finanzbuchhalter / Accountant', a
 * working-student position in influencer marketing, and 'Facility Manager /
 * Leiter Immobilien & Gebäudemanagement'.
 *
 * Sector: E-commerce (rugs & home textiles). HQ: Bonn, Germany.
 *
 * Source: Recruitee careers board, subdomain `benutagmbh`
 * (`https://benutagmbh.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'benutagmbh';
const COMPANY_NAME = 'benuta';

@SourcePlugin({
  site: Site.BENUTA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BenutaService implements IScraper {
  private readonly logger = new Logger(BenutaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape benuta',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `benuta: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BENUTA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'benuta-');
      }
    }

    this.logger.log(`benuta: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
