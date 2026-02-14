import { Module } from '@nestjs/common';
import { LinkedInModule } from '@ever-jobs/source-linkedin';
import { IndeedModule } from '@ever-jobs/source-indeed';
import { GlassdoorModule } from '@ever-jobs/source-glassdoor';
import { ZipRecruiterModule } from '@ever-jobs/source-ziprecruiter';
import { GoogleModule } from '@ever-jobs/source-google';
import { BaytModule } from '@ever-jobs/source-bayt';
import { NaukriModule } from '@ever-jobs/source-naukri';
import { BDJobsModule } from '@ever-jobs/source-bdjobs';
import { InternshalaModule } from '@ever-jobs/source-internshala';
import { ExaModule } from '@ever-jobs/source-exa';
import { UpworkModule } from '@ever-jobs/source-upwork';
import { AshbyModule } from '@ever-jobs/source-ats-ashby';
import { GreenhouseModule } from '@ever-jobs/source-ats-greenhouse';
import { LeverModule } from '@ever-jobs/source-ats-lever';
import { WorkableModule } from '@ever-jobs/source-ats-workable';
import { SmartRecruitersModule } from '@ever-jobs/source-ats-smartrecruiters';
import { RipplingModule } from '@ever-jobs/source-ats-rippling';
import { WorkdayModule } from '@ever-jobs/source-ats-workday';
import { AmazonModule } from '@ever-jobs/source-company-amazon';
import { AppleModule } from '@ever-jobs/source-company-apple';
import { MicrosoftModule } from '@ever-jobs/source-company-microsoft';
import { NvidiaModule } from '@ever-jobs/source-company-nvidia';
import { TikTokModule } from '@ever-jobs/source-company-tiktok';
import { UberModule } from '@ever-jobs/source-company-uber';
import { CursorModule } from '@ever-jobs/source-company-cursor';
import { RemoteOkModule } from '@ever-jobs/source-remoteok';
import { RemotiveModule } from '@ever-jobs/source-remotive';
import { JobicyModule } from '@ever-jobs/source-jobicy';
import { HimalayasModule } from '@ever-jobs/source-himalayas';
import { ArbeitnowModule } from '@ever-jobs/source-arbeitnow';
import { WeWorkRemotelyModule } from '@ever-jobs/source-weworkremotely';
import { RecruiteeModule } from '@ever-jobs/source-ats-recruitee';
import { TeamtailorModule } from '@ever-jobs/source-ats-teamtailor';
import { UsajobsModule } from '@ever-jobs/source-usajobs';
import { AdzunaModule } from '@ever-jobs/source-adzuna';
import { ReedModule } from '@ever-jobs/source-reed';
import { JoobleModule } from '@ever-jobs/source-jooble';
import { CareerJetModule } from '@ever-jobs/source-careerjet';
import { AnalyticsModule } from '@ever-jobs/analytics';
import { JobsService } from '../../api/src/jobs/jobs.service';
import { SearchCommand } from './commands/search.command';
import { CompareCommand } from './commands/compare.command';

@Module({
  imports: [
    // Search-based sources
    LinkedInModule,
    IndeedModule,
    GlassdoorModule,
    ZipRecruiterModule,
    GoogleModule,
    BaytModule,
    NaukriModule,
    BDJobsModule,
    InternshalaModule,
    ExaModule,
    UpworkModule,
    // ATS sources
    AshbyModule,
    GreenhouseModule,
    LeverModule,
    WorkableModule,
    SmartRecruitersModule,
    RipplingModule,
    WorkdayModule,
    // Company-specific sources
    AmazonModule,
    AppleModule,
    MicrosoftModule,
    NvidiaModule,
    TikTokModule,
    UberModule,
    CursorModule,
    // Remote job boards
    RemoteOkModule,
    RemotiveModule,
    JobicyModule,
    HimalayasModule,
    ArbeitnowModule,
    WeWorkRemotelyModule,
    // Additional ATS sources
    RecruiteeModule,
    TeamtailorModule,
    // API-key sources (Tier 1.5)
    UsajobsModule,
    AdzunaModule,
    ReedModule,
    JoobleModule,
    CareerJetModule,
    // Analytics
    AnalyticsModule,
  ],
  providers: [JobsService, SearchCommand, CompareCommand],
})
export class CliModule {}
