import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * incident.io — All-in-one incident management platform for engineering teams.
 *
 * incident.io provides an incident management platform that unifies on-call
 * scheduling, real-time incident response, and status pages. It is designed
 * to help engineering teams coordinate during and after incidents.
 *
 * Sector: Developer infrastructure / Incident management. HQ: London, England, United Kingdom.
 *
 * Source: Ashby job board, company slug `incident`
 * (`https://jobs.ashbyhq.com/incident`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'incident';
const COMPANY_NAME = 'incident.io';

@SourcePlugin({
  site: Site.INCIDENT_IO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IncidentIoService implements IScraper {
  private readonly logger = new Logger(IncidentIoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape incident.io',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `incident.io: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INCIDENT_IO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'incidentio-');
      }
    }

    this.logger.log(`incident.io: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
