import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Aikido Security — Application security platform (SAST, DAST, cloud/container scanning) for developers.
 *
 * Aikido Security is a Ghent-based software security company offering a
 * developer-focused platform that consolidates code, cloud, and container
 * security scanning. Its Recruitee board at aikidosecurity.recruitee.com
 * listed 11 open roles across engineering, sales, customer success, and
 * operations.
 *
 * Sector: Software / Cybersecurity. HQ: Ghent, Belgium.
 *
 * Source: Recruitee careers board, subdomain `aikidosecurity`
 * (`https://aikidosecurity.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'aikidosecurity';
const COMPANY_NAME = 'Aikido Security';

@SourcePlugin({
  site: Site.AIKIDO_SECURITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AikidoSecurityService implements IScraper {
  private readonly logger = new Logger(AikidoSecurityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Aikido Security',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Aikido Security: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AIKIDO_SECURITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'aikidosecurity-');
      }
    }

    this.logger.log(`Aikido Security: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
