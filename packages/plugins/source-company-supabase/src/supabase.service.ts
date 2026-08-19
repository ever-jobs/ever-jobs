import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Supabase — Open-source Postgres development platform providing database, auth, storage, and realtime services.
 *
 * Supabase is a developer platform built around PostgreSQL, providing a
 * managed database along with authentication, storage, edge functions,
 * realtime subscriptions, and vector search. It positions itself as an
 * open-source backend-as-a-service. The company is fully remote.
 *
 * Sector: Databases / Developer Data Platform. HQ: Remote (US-registered).
 *
 * Source: Ashby job board, company slug `supabase`
 * (`https://jobs.ashbyhq.com/supabase`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'supabase';
const COMPANY_NAME = 'Supabase';

@SourcePlugin({
  site: Site.SUPABASE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SupabaseService implements IScraper {
  private readonly logger = new Logger(SupabaseService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Supabase',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Supabase: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SUPABASE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'supabase-');
      }
    }

    this.logger.log(`Supabase: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
