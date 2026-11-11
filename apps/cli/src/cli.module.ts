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
import { BambooHRModule } from '@ever-jobs/source-ats-bamboohr';
import { PersonioModule } from '@ever-jobs/source-ats-personio';
import { JazzHRModule } from '@ever-jobs/source-ats-jazzhr';
import { DiceModule } from '@ever-jobs/source-dice';
import { SimplyHiredModule } from '@ever-jobs/source-simplyhired';
import { WellfoundModule } from '@ever-jobs/source-wellfound';
import { StepStoneModule } from '@ever-jobs/source-stepstone';
import { MonsterModule } from '@ever-jobs/source-monster';
import { CareerBuilderModule } from '@ever-jobs/source-careerbuilder';
import { IcimsModule } from '@ever-jobs/source-ats-icims';
import { TaleoModule } from '@ever-jobs/source-ats-taleo';
import { SuccessFactorsModule } from '@ever-jobs/source-ats-successfactors';
import { JobviteModule } from '@ever-jobs/source-ats-jobvite';
import { AdpModule } from '@ever-jobs/source-ats-adp';
import { UkgModule } from '@ever-jobs/source-ats-ukg';
import { GoogleCareersModule } from '@ever-jobs/source-company-google';
import { MetaModule } from '@ever-jobs/source-company-meta';
import { NetflixModule } from '@ever-jobs/source-company-netflix';
import { StripeModule } from '@ever-jobs/source-company-stripe';
import { OpenAIModule } from '@ever-jobs/source-company-openai';
import { BreezyHRModule } from '@ever-jobs/source-ats-breezyhr';
import { ComeetModule } from '@ever-jobs/source-ats-comeet';
import { PinpointModule } from '@ever-jobs/source-ats-pinpoint';
import { BuiltInModule } from '@ever-jobs/source-builtin';
import { SnagajobModule } from '@ever-jobs/source-snagajob';
import { DribbbleModule } from '@ever-jobs/source-dribbble';
// Phase 8: ATS Expansion
import { ManatalModule } from '@ever-jobs/source-ats-manatal';
import { PaylocityModule } from '@ever-jobs/source-ats-paylocity';
import { FreshteamModule } from '@ever-jobs/source-ats-freshteam';
import { BullhornModule } from '@ever-jobs/source-ats-bullhorn';
import { TrakstarModule } from '@ever-jobs/source-ats-trakstar';
import { HiringThingModule } from '@ever-jobs/source-ats-hiringthing';
import { LoxoModule } from '@ever-jobs/source-ats-loxo';
import { FountainModule } from '@ever-jobs/source-ats-fountain';
import { DeelModule } from '@ever-jobs/source-ats-deel';
import { PhenomModule } from '@ever-jobs/source-ats-phenom';
import { IbmModule } from '@ever-jobs/source-company-ibm';
import { BoeingModule } from '@ever-jobs/source-company-boeing';
import { ZoomModule } from '@ever-jobs/source-company-zoom';
// Phase 9: Job board expansion
import { TheMuseModule } from '@ever-jobs/source-themuse';
import { WorkingNomadsModule } from '@ever-jobs/source-workingnomads';
import { FourDayWeekModule } from '@ever-jobs/source-4dayweek';
import { StartupJobsModule } from '@ever-jobs/source-startupjobs';
import { NoDeskModule } from '@ever-jobs/source-nodesk';
import { Web3CareerModule } from '@ever-jobs/source-web3career';
import { EchoJobsModule } from '@ever-jobs/source-echojobs';
import { JobstreetModule } from '@ever-jobs/source-jobstreet';
// Phase 10: Government boards & ATS expansion
import { CareerOneStopModule } from '@ever-jobs/source-careeronestop';
import { ArbeitsagenturModule } from '@ever-jobs/source-arbeitsagentur';
import { JobylonModule } from '@ever-jobs/source-ats-jobylon';
import { HomerunModule } from '@ever-jobs/source-ats-homerun';
// Phase 11: Niche boards & developer API expansion
import { HackerNewsModule } from '@ever-jobs/source-hackernews';
import { LandingJobsModule } from '@ever-jobs/source-landingjobs';
import { FindWorkModule } from '@ever-jobs/source-findwork';
import { JobDataApiModule } from '@ever-jobs/source-jobdataapi';
// Phase 12: ATS & niche board expansion
import { AuthenticJobsModule } from '@ever-jobs/source-authenticjobs';
import { JobScoreModule } from '@ever-jobs/source-ats-jobscore';
import { TalentLyftModule } from '@ever-jobs/source-ats-talentlyft';
// Phase 13: RSS niche board expansion
import { CryptoJobsListModule } from '@ever-jobs/source-cryptojobslist';
import { JobspressoModule } from '@ever-jobs/source-jobspresso';
import { HigherEdJobsModule } from '@ever-jobs/source-higheredjobs';
import { FossJobsModule } from '@ever-jobs/source-fossjobs';
import { LaraJobsModule } from '@ever-jobs/source-larajobs';
import { PythonJobsModule } from '@ever-jobs/source-pythonjobs';
import { DrupalJobsModule } from '@ever-jobs/source-drupaljobs';
import { RealWorkFromAnywhereModule } from '@ever-jobs/source-realworkfromanywhere';
import { GolangJobsModule } from '@ever-jobs/source-golangjobs';
import { WordPressJobsModule } from '@ever-jobs/source-wordpressjobs';
// Phase 14: API-key sources & ATS expansion
import { TalrooModule } from '@ever-jobs/source-talroo';
import { InfoJobsModule } from '@ever-jobs/source-infojobs';
import { CrelateModule } from '@ever-jobs/source-ats-crelate';
import { ISmartRecruitModule } from '@ever-jobs/source-ats-ismartrecruit';
import { RecruiterflowModule } from '@ever-jobs/source-ats-recruiterflow';
// Phase 15: European government & regional boards
import { JobTechDevModule } from '@ever-jobs/source-jobtechdev';
import { FranceTravailModule } from '@ever-jobs/source-francetravail';
import { NavJobsModule } from '@ever-jobs/source-navjobs';
import { JobsAcUkModule } from '@ever-jobs/source-jobsacuk';
import { JobindexModule } from '@ever-jobs/source-jobindex';
// Phase 16: Global expansion (LatAm, gig, startup, Canada)
import { GetOnBoardModule } from '@ever-jobs/source-getonboard';
import { FreelancerComModule } from '@ever-jobs/source-freelancercom';
import { JoinRiseModule } from '@ever-jobs/source-joinrise';
import { CanadaJobBankModule } from '@ever-jobs/source-canadajobbank';
// Phase 17: Niche & international expansion (NGO, UN, IT)
import { ReliefWebModule } from '@ever-jobs/source-reliefweb';
import { UndpJobsModule } from '@ever-jobs/source-undpjobs';
import { DevITJobsModule } from '@ever-jobs/source-devitjobs';
// Phase 18: Niche RSS expansion (tech, design, environment, regional)
import { PyJobsModule } from '@ever-jobs/source-pyjobs';
import { VueJobsModule } from '@ever-jobs/source-vuejobs';
import { ConservationJobsModule } from '@ever-jobs/source-conservationjobs';
import { CoroflotModule } from '@ever-jobs/source-coroflot';
import { BerlinStartupJobsModule } from '@ever-jobs/source-berlinstartupjobs';
// Phase 19: Tech niche, crypto, regional expansion
import { RailsJobsModule } from '@ever-jobs/source-railsjobs';
import { ElixirJobsModule } from '@ever-jobs/source-elixirjobs';
import { CrunchboardModule } from '@ever-jobs/source-crunchboard';
import { CryptocurrencyJobsModule } from '@ever-jobs/source-cryptocurrencyjobs';
import { HasJobModule } from '@ever-jobs/source-hasjob';
// Phase 20: European regional & niche expansion
import { IcrunchdataModule } from '@ever-jobs/source-icrunchdata';
import { SwissdevjobsModule } from '@ever-jobs/source-swissdevjobs';
import { GermantechjobsModule } from '@ever-jobs/source-germantechjobs';
import { VirtualVocationsModule } from '@ever-jobs/source-virtualvocations';
import { NoFluffJobsModule } from '@ever-jobs/source-nofluffjobs';
// Phase 21: Niche & academic expansion
import { GreenJobsBoardModule } from '@ever-jobs/source-greenjobsboard';
import { EurojobsModule } from '@ever-jobs/source-eurojobs';
import { OpensourcedesignjobsModule } from '@ever-jobs/source-opensourcedesignjobs';
import { AcademiccareersModule } from '@ever-jobs/source-academiccareers';
import { RemotefirstjobsModule } from '@ever-jobs/source-remotefirstjobs';
// Phase 22: Eastern European, CIS & Singapore expansion
import { DjinniModule } from '@ever-jobs/source-djinni';
import { HeadhunterModule } from '@ever-jobs/source-headhunter';
import { HabrcareerModule } from '@ever-jobs/source-habrcareer';
import { MycareersfutureModule } from '@ever-jobs/source-mycareersfuture';
// Phase 23: Japan, Nordic & Swiss expansion
import { JobsInJapanModule } from '@ever-jobs/source-jobsinjapan';
import { DuunitoriModule } from '@ever-jobs/source-duunitori';
import { JobsChModule } from '@ever-jobs/source-jobsch';
// Phase 24: UK & mobile dev expansion
import { GuardianjobsModule } from '@ever-jobs/source-guardianjobs';
import { AndroidjobsModule } from '@ever-jobs/source-androidjobs';
import { IosdevjobsModule } from '@ever-jobs/source-iosdevjobs';
// Phase 25: DevOps niche expansion
import { DevopsjobsModule } from '@ever-jobs/source-devopsjobs';
// Phase 25: FP, diversity & niche expansion
import { FunctionalworksModule } from '@ever-jobs/source-functionalworks';
import { PowertoflyModule } from '@ever-jobs/source-powertofly';
import { ClojurejobsModule } from '@ever-jobs/source-clojurejobs';
// Phase 26: Sustainability & niche expansion
import { EcojobsModule } from '@ever-jobs/source-ecojobs';
import { AnalyticsModule } from '@ever-jobs/analytics';
import { PluginModule } from '@ever-jobs/plugin';
import { AppConfigModule } from '../../api/src/config/config.module';
import { MetricsModule } from '../../api/src/metrics/metrics.module';
import { JobsService } from '../../api/src/jobs/jobs.service';
import { SearchCommand } from './commands/search.command';
import { CompareCommand } from './commands/compare.command';

@Module({
  imports: [
    // JobsService dependencies: PluginRegistry, ConfigService, MetricsService
    AppConfigModule,
    MetricsModule,
    PluginModule,
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
    // Phase 3 ATS sources
    BambooHRModule,
    PersonioModule,
    JazzHRModule,
    // Phase 3 Playwright sources
    DiceModule,
    SimplyHiredModule,
    WellfoundModule,
    StepStoneModule,
    MonsterModule,
    CareerBuilderModule,
    // Phase 4 Tier 3 ATS sources
    IcimsModule,
    TaleoModule,
    SuccessFactorsModule,
    // Phase 5 ATS sources
    JobviteModule,
    AdpModule,
    UkgModule,
    // Phase 6: New company scrapers
    GoogleCareersModule,
    MetaModule,
    NetflixModule,
    StripeModule,
    OpenAIModule,
    // Phase 6: New ATS sources
    BreezyHRModule,
    ComeetModule,
    PinpointModule,
    // Phase 7: Additional job boards
    BuiltInModule,
    SnagajobModule,
    DribbbleModule,
    // Phase 8: ATS Expansion
    ManatalModule,
    PaylocityModule,
    FreshteamModule,
    BullhornModule,
    TrakstarModule,
    HiringThingModule,
    LoxoModule,
    FountainModule,
    DeelModule,
    PhenomModule,
    // Phase 8: Company scrapers
    IbmModule,
    BoeingModule,
    ZoomModule,
    // Phase 9: Job board expansion
    TheMuseModule,
    WorkingNomadsModule,
    FourDayWeekModule,
    StartupJobsModule,
    NoDeskModule,
    Web3CareerModule,
    EchoJobsModule,
    JobstreetModule,
    // Phase 10: Government boards & ATS expansion
    CareerOneStopModule,
    ArbeitsagenturModule,
    JobylonModule,
    HomerunModule,
    // Phase 11: Niche boards & developer API expansion
    HackerNewsModule,
    LandingJobsModule,
    FindWorkModule,
    JobDataApiModule,
    // Phase 12: ATS & niche board expansion
    AuthenticJobsModule,
    JobScoreModule,
    TalentLyftModule,
    // Phase 13: RSS niche board expansion
    CryptoJobsListModule,
    JobspressoModule,
    HigherEdJobsModule,
    FossJobsModule,
    LaraJobsModule,
    PythonJobsModule,
    DrupalJobsModule,
    RealWorkFromAnywhereModule,
    GolangJobsModule,
    WordPressJobsModule,
    // Phase 14: API-key sources & ATS expansion
    TalrooModule,
    InfoJobsModule,
    CrelateModule,
    ISmartRecruitModule,
    RecruiterflowModule,
    // Phase 15: European government & regional boards
    JobTechDevModule,
    FranceTravailModule,
    NavJobsModule,
    JobsAcUkModule,
    JobindexModule,
    // Phase 16: Global expansion (LatAm, gig, startup, Canada)
    GetOnBoardModule,
    FreelancerComModule,
    JoinRiseModule,
    CanadaJobBankModule,
    // Phase 17: Niche & international expansion (NGO, UN, IT)
    ReliefWebModule,
    UndpJobsModule,
    DevITJobsModule,
    // Phase 18: Niche RSS expansion (tech, design, environment, regional)
    PyJobsModule,
    VueJobsModule,
    ConservationJobsModule,
    CoroflotModule,
    BerlinStartupJobsModule,
    // Phase 19: Tech niche, crypto, regional expansion
    RailsJobsModule,
    ElixirJobsModule,
    CrunchboardModule,
    CryptocurrencyJobsModule,
    HasJobModule,
    // Phase 20: European regional & niche expansion
    IcrunchdataModule,
    SwissdevjobsModule,
    GermantechjobsModule,
    VirtualVocationsModule,
    NoFluffJobsModule,
    // Phase 21: Niche & academic expansion
    GreenJobsBoardModule,
    EurojobsModule,
    OpensourcedesignjobsModule,
    AcademiccareersModule,
    RemotefirstjobsModule,
    // Phase 22: Eastern European, CIS & Singapore expansion
    DjinniModule,
    HeadhunterModule,
    HabrcareerModule,
    MycareersfutureModule,
    // Phase 23: Japan, Nordic & Swiss expansion
    JobsInJapanModule,
    DuunitoriModule,
    JobsChModule,
    // Phase 24: UK & mobile dev expansion
    GuardianjobsModule,
    AndroidjobsModule,
    IosdevjobsModule,
    // Phase 25: DevOps niche expansion
    DevopsjobsModule,
    // Phase 25: FP, diversity & niche expansion
    FunctionalworksModule,
    PowertoflyModule,
    ClojurejobsModule,
    // Phase 26: Sustainability & niche expansion
    EcojobsModule,
    // Analytics
    AnalyticsModule,
  ],
  providers: [JobsService, SearchCommand, CompareCommand],
})
export class CliModule {}
