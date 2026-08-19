import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Centric — IT services and software provider delivering software solutions, consulting, and outsourcing.
 *
 * Centric is a Dutch IT company providing software solutions, IT services,
 * consulting, and outsourcing across sectors, including work on the
 * Thinkwise low-code platform. It hires across consulting, development, and
 * support roles in the Netherlands.
 *
 * Sector: IT services / enterprise software. HQ: Gouda, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `centric`
 * (`https://centric.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'centric';
const COMPANY_NAME = 'Centric';

@SourcePlugin({
  site: Site.CENTRIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CentricService implements IScraper {
  private readonly logger = new Logger(CentricService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Centric',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Centric: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CENTRIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'centric-');
      }
    }

    this.logger.log(`Centric: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
