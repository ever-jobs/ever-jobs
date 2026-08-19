import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mistertemp\' Group — HR-tech group combining digital staffing platforms with a network of physical agencies.
 *
 * Mistertemp' Group is a French HR-tech company that blends digital
 * innovation with local agency presence for temporary work and permanent
 * placement. It has built proprietary software including MisterMatch (an
 * HRIS for staffing agencies) and Mistertemp'+ (a SaaS platform for
 * healthcare-facility staffing), and operates in France, Italy, Spain and
 * Canada. Careers are hosted on Recruitee at jobsmistertemp.recruitee.com.
 *
 * Sector: HR Tech / Staffing SaaS. HQ: Paris, France.
 *
 * Source: Recruitee careers board, subdomain `jobsmistertemp`
 * (`https://jobsmistertemp.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'jobsmistertemp';
const COMPANY_NAME = 'Mistertemp\' Group';

@SourcePlugin({
  site: Site.MISTERTEMP_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MistertempGroupService implements IScraper {
  private readonly logger = new Logger(MistertempGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Mistertemp\' Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mistertemp\' Group: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MISTERTEMP_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'mistertempgroup-');
      }
    }

    this.logger.log(`Mistertemp\' Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
