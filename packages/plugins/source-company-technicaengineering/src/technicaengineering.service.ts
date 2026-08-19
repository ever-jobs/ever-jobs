import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Technica Engineering — Automotive software and electronics for vehicle data communication.
 *
 * Technica Engineering GmbH develops and produces its own software and
 * electronic products in the field of vehicle development, specializing in
 * automotive Ethernet and ECU development. It is headquartered in Munich.
 *
 * Sector: Automotive software / electronics. HQ: Munich, Germany.
 *
 * Source: Recruitee careers board, subdomain `technicaengineeringgmbh`
 * (`https://technicaengineeringgmbh.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'technicaengineeringgmbh';
const COMPANY_NAME = 'Technica Engineering';

@SourcePlugin({
  site: Site.TECHNICA_ENGINEERING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TechnicaEngineeringService implements IScraper {
  private readonly logger = new Logger(TechnicaEngineeringService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Technica Engineering',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Technica Engineering: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TECHNICA_ENGINEERING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'technicaengineering-');
      }
    }

    this.logger.log(`Technica Engineering: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
