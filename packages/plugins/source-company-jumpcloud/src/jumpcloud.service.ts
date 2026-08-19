import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * JumpCloud — Cloud directory platform unifying identity, access management, and device security across operating systems.
 *
 * JumpCloud provides an open directory platform that unifies identity and
 * access management, single sign-on, multi-factor authentication, and
 * cross-OS device management, enabling organizations to secure user
 * identities and manage endpoints from the cloud.
 *
 * Sector: Cybersecurity (Identity & Access Management). HQ: Louisville, Colorado, United States.
 *
 * Source: Lever job board, company slug `jumpcloud`
 * (`https://jobs.lever.co/jumpcloud`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'jumpcloud';
const COMPANY_NAME = 'JumpCloud';

@SourcePlugin({
  site: Site.JUMPCLOUD,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class JumpCloudService implements IScraper {
  private readonly logger = new Logger(JumpCloudService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape JumpCloud',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `JumpCloud: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.JUMPCLOUD;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'jumpcloud-');
      }
    }

    this.logger.log(`JumpCloud: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
