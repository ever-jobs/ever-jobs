import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Elephant Technologies — Technology consulting and engineering services firm (ESN) specializing in QA, DevOps and project delivery.
 *
 * Elephant Technologies is a French technology consulting and
 * engineering-services company (ESN) headquartered in Nantes, providing
 * consultants for quality assurance, project management, DevOps and
 * technical leadership, primarily serving clients in the Nantes region.
 * Careers are hosted on Recruitee at elephanttechnologies.recruitee.com.
 *
 * Sector: IT services / Engineering (ESN). HQ: Nantes, France.
 *
 * Source: Recruitee careers board, subdomain `elephanttechnologies`
 * (`https://elephanttechnologies.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'elephanttechnologies';
const COMPANY_NAME = 'Elephant Technologies';

@SourcePlugin({
  site: Site.ELEPHANT_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ElephantTechnologiesService implements IScraper {
  private readonly logger = new Logger(ElephantTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Elephant Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Elephant Technologies: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ELEPHANT_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'elephanttechnologies-');
      }
    }

    this.logger.log(`Elephant Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
