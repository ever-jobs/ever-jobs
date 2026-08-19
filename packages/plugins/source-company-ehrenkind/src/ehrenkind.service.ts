import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ehrenkind — German e-commerce brand selling its products via online marketplaces including Amazon and Otto.
 *
 * Ehrenkind GmbH is a German e-commerce company that sells its products
 * through online marketplaces such as Amazon and Otto. Its Recruitee board
 * (ehrenkindgmbh.recruitee.com) returned a JSON offers array with roles
 * including 'E-Commerce Marketplace Manager (m/w/d) - Amazon und Otto' and
 * 'Fachkraft Lagerlogistik', with locations in Schwäbisch Hall and Heiden.
 *
 * Sector: E-commerce / marketplace seller (consumer brand). HQ: Schwäbisch Hall, Germany.
 *
 * Source: Recruitee careers board, subdomain `ehrenkindgmbh`
 * (`https://ehrenkindgmbh.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'ehrenkindgmbh';
const COMPANY_NAME = 'Ehrenkind';

@SourcePlugin({
  site: Site.EHRENKIND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EhrenkindService implements IScraper {
  private readonly logger = new Logger(EhrenkindService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Ehrenkind',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ehrenkind: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EHRENKIND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'ehrenkind-');
      }
    }

    this.logger.log(`Ehrenkind: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
