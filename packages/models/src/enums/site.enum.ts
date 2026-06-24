export enum Site {
  LINKEDIN = 'linkedin',
  INDEED = 'indeed',
  ZIP_RECRUITER = 'zip_recruiter',
  GLASSDOOR = 'glassdoor',
  GOOGLE = 'google',
  BAYT = 'bayt',
  NAUKRI = 'naukri',
  BDJOBS = 'bdjobs',
  INTERNSHALA = 'internshala',
  EXA = 'exa',
  UPWORK = 'upwork',
  ASHBY = 'ashby',
  GREENHOUSE = 'greenhouse',
  LEVER = 'lever',
  WORKABLE = 'workable',
  SMARTRECRUITERS = 'smartrecruiters',
  RIPPLING = 'rippling',
  WORKDAY = 'workday',
  AMAZON = 'amazon',
  APPLE = 'apple',
  MICROSOFT = 'microsoft',
  NVIDIA = 'nvidia',
  TIKTOK = 'tiktok',
  UBER = 'uber',
  CURSOR = 'cursor',
  JOBICY = 'jobicy',
  HIMALAYAS = 'himalayas',
  REMOTEOK = 'remoteok',
  REMOTIVE = 'remotive',
  RECRUITEE = 'recruitee',
  TEAMTAILOR = 'teamtailor',
  ARBEITNOW = 'arbeitnow',
  WEWORKREMOTELY = 'weworkremotely',
  USAJOBS = 'usajobs',
  ADZUNA = 'adzuna',
  REED = 'reed',
  JOOBLE = 'jooble',
  CAREERJET = 'careerjet',
  BAMBOOHR = 'bamboohr',
  PERSONIO = 'personio',
  JAZZHR = 'jazzhr',
  DICE = 'dice',
  SIMPLYHIRED = 'simplyhired',
  WELLFOUND = 'wellfound',
  STEPSTONE = 'stepstone',
  MONSTER = 'monster',
  CAREERBUILDER = 'careerbuilder',
  ICIMS = 'icims',
  TALEO = 'taleo',
  SUCCESSFACTORS = 'successfactors',
  JOBVITE = 'jobvite',
  ADP = 'adp',
  UKG = 'ukg',
  // Phase 6: New company scrapers
  GOOGLE_CAREERS = 'google_careers',
  META = 'meta',
  NETFLIX = 'netflix',
  STRIPE = 'stripe',
  OPENAI = 'openai',
  // Phase 6: New ATS integrations
  BREEZYHR = 'breezyhr',
  // Generic schema.org JobPosting (JSON-LD) harvester — aggregator bucket, not an ATS.
  JSONLD = 'jsonld',
  COMEET = 'comeet',
  PINPOINT = 'pinpoint',
  // Phase 7: Additional job boards
  BUILTIN = 'builtin',
  SNAGAJOB = 'snagajob',
  DRIBBBLE = 'dribbble',
  // Phase 8: ATS Expansion
  MANATAL = 'manatal',
  PAYLOCITY = 'paylocity',
  // YC Work at a Startup — multi-tenant ATS (harvested via the YC mirror).
  WORKATASTARTUP = 'workatastartup',
  FRESHTEAM = 'freshteam',
  BULLHORN = 'bullhorn',
  TRAKSTAR = 'trakstar',
  HIRINGTHING = 'hiringthing',
  LOXO = 'loxo',
  FOUNTAIN = 'fountain',
  DEEL = 'deel',
  PHENOM = 'phenom',
  EIGHTFOLD = 'eightfold',
  ZOHORECRUIT = 'zohorecruit',
  // Phase 8: Company scrapers
  IBM = 'ibm',
  BOEING = 'boeing',
  ZOOM = 'zoom',
  // Phase 9: Job board expansion
  THEMUSE = 'themuse',
  WORKINGNOMADS = 'workingnomads',
  FOURDAYWEEK = 'fourdayweek',
  STARTUPJOBS = 'startupjobs',
  NODESK = 'nodesk',
  WEB3CAREER = 'web3career',
  ECHOJOBS = 'echojobs',
  JOBSTREET = 'jobstreet',
  // Phase 10: Government boards & ATS expansion
  CAREERONESTOP = 'careeronestop',
  ARBEITSAGENTUR = 'arbeitsagentur',
  JOBYLON = 'jobylon',
  HOMERUN = 'homerun',
  // Phase 11: Niche boards & developer API expansion
  HACKERNEWS = 'hackernews',
  LANDINGJOBS = 'landingjobs',
  FINDWORK = 'findwork',
  JOBDATAAPI = 'jobdataapi',
  // Phase 12: ATS & niche board expansion
  AUTHENTICJOBS = 'authenticjobs',
  JOBSCORE = 'jobscore',
  TALENTLYFT = 'talentlyft',
  // Phase 13: RSS niche board expansion
  CRYPTOJOBSLIST = 'cryptojobslist',
  JOBSPRESSO = 'jobspresso',
  HIGHEREDJOBS = 'higheredjobs',
  FOSSJOBS = 'fossjobs',
  LARAJOBS = 'larajobs',
  PYTHONJOBS = 'pythonjobs',
  DRUPALJOBS = 'drupaljobs',
  REALWORKFROMANYWHERE = 'realworkfromanywhere',
  GOLANGJOBS = 'golangjobs',
  WORDPRESSJOBS = 'wordpressjobs',
  // Phase 14: API-key sources & ATS expansion
  TALROO = 'talroo',
  INFOJOBS = 'infojobs',
  CRELATE = 'crelate',
  ISMARTRECRUIT = 'ismartrecruit',
  RECRUITERFLOW = 'recruiterflow',
  // Phase 15: European government & regional boards
  JOBTECHDEV = 'jobtechdev',
  FRANCETRAVAIL = 'francetravail',
  NAVJOBS = 'navjobs',
  JOBSACUK = 'jobsacuk',
  JOBINDEX = 'jobindex',
  // Phase 16: Global expansion (LatAm, gig, startup, Canada)
  GETONBOARD = 'getonboard',
  FREELANCERCOM = 'freelancercom',
  JOINRISE = 'joinrise',
  CANADAJOBBANK = 'canadajobbank',
  // Phase 17: Niche & international expansion (NGO, UN, IT)
  RELIEFWEB = 'reliefweb',
  UNDPJOBS = 'undpjobs',
  DEVITJOBS = 'devitjobs',
  // Phase 18: Niche RSS expansion (tech, design, environment, regional)
  PYJOBS = 'pyjobs',
  VUEJOBS = 'vuejobs',
  CONSERVATIONJOBS = 'conservationjobs',
  COROFLOT = 'coroflot',
  BERLINSTARTUPJOBS = 'berlinstartupjobs',
  // Phase 19: Tech niche, crypto, regional expansion
  RAILSJOBS = 'railsjobs',
  ELIXIRJOBS = 'elixirjobs',
  CRUNCHBOARD = 'crunchboard',
  CRYPTOCURRENCYJOBS = 'cryptocurrencyjobs',
  HASJOB = 'hasjob',
  // Phase 20: European regional & niche expansion
  ICRUNCHDATA = 'icrunchdata',
  SWISSDEVJOBS = 'swissdevjobs',
  GERMANTECHJOBS = 'germantechjobs',
  VIRTUALVOCATIONS = 'virtualvocations',
  NOFLUFFJOBS = 'nofluffjobs',
  // Phase 21: Niche & academic expansion
  GREENJOBSBOARD = 'greenjobsboard',
  EUROJOBS = 'eurojobs',
  OPENSOURCEDESIGNJOBS = 'opensourcedesignjobs',
  ACADEMICCAREERS = 'academiccareers',
  REMOTEFIRSTJOBS = 'remotefirstjobs',
  // Phase 22: Eastern European, CIS & Singapore expansion
  DJINNI = 'djinni',
  HEADHUNTER = 'headhunter',
  HABRCAREER = 'habrcareer',
  MYCAREERSFUTURE = 'mycareersfuture',
  // Phase 23: Japan, Nordic & Swiss expansion
  JOBSINJAPAN = 'jobsinjapan',
  DUUNITORI = 'duunitori',
  JOBSCH = 'jobsch',
  // Phase 24: UK & mobile dev expansion
  GUARDIANJOBS = 'guardianjobs',
  ANDROIDJOBS = 'androidjobs',
  IOSDEVJOBS = 'iosdevjobs',
  // Phase 25: DevOps, FP, diversity & niche expansion
  DEVOPSJOBS = 'devopsjobs',
  FUNCTIONALWORKS = 'functionalworks',
  POWERTOFLY = 'powertofly',
  CLOJUREJOBS = 'clojurejobs',
  // Phase 26: Environmental & conservation
  ECOJOBS = 'ecojobs',
  // Phase 27: Asia-Pacific & US tech expansion
  JOBSDB = 'jobsdb',
  TECHCAREERS = 'techcareers',
  // Phase 28: Spec 006 — ATS-Scrapers Parity, Batch 1
  AVATURE = 'avature',
  GEM = 'gem',
  JOIN_COM = 'join_com',
  // Phase 29: Spec 013 — ATS-Scrapers Parity, Batch 2 (Oracle HCM / Mercor / Tesla)
  ORACLE = 'oracle',
  MERCOR = 'mercor',
  TESLA = 'tesla',
  TESLA_PLAYWRIGHT = 'tesla_playwright',
  // Phase 30: Spec 020 — Source Company Plugin: Anthropic
  ANTHROPIC = 'anthropic',
  // Phase 31: Spec 021 — Source Company Plugin: Databricks
  DATABRICKS = 'databricks',
  // Phase 32: Spec 022 — Source Company Plugin: Discord
  DISCORD = 'discord',
  // Phase 33: Spec 023 — Source Company Plugin: Coinbase
  COINBASE = 'coinbase',
  // Phase 34: Spec 024 — Source Company Plugin: DoorDash
  DOORDASH = 'doordash',
  // Phase 35: Spec 025 — Source Company Plugin: Airbnb
  AIRBNB = 'airbnb',
  // Phase 36: Spec 026 — Source Company Plugin: Robinhood
  ROBINHOOD = 'robinhood',
  // Phase 37: Spec 027 — Source Company Plugin: Reddit
  REDDIT = 'reddit',
  // Phase 38: Spec 028 — Source Company Plugin: Pinterest
  PINTEREST = 'pinterest',
  // Phase 39: Spec 029 — Source Company Plugin: Lyft
  LYFT = 'lyft',
  // Phase 40: Spec 030 — Source Company Plugin: Plaid
  PLAID = 'plaid',
  // Phase 41: Spec 031 — Source Company Plugin: Asana
  ASANA = 'asana',
  // Phase 42: Spec 032 — Source Company Plugin: Figma
  FIGMA = 'figma',
  // Phase 43: Spec 033 — Source Company Plugin: Gitlab
  GITLAB = 'gitlab',
  // Phase 44: Spec 034 — Source Company Plugin: Twitch
  TWITCH = 'twitch',
  // Phase 45: Spec 035 — Source Company Plugin: Twilio
  TWILIO = 'twilio',
  // Phase 46: Spec 036 — Source Company Plugin: Cloudflare
  CLOUDFLARE = 'cloudflare',
  // Phase 47: Spec 037 — Source Company Plugin: MongoDB
  MONGODB = 'mongodb',
  // Phase 48: Spec 038 — Source Company Plugin: Datadog
  DATADOG = 'datadog',
  // Phase 49: Spec 039 — Source Company Plugin: Instacart
  INSTACART = 'instacart',
  // Phase 50: Spec 040 — Source Company Plugin: Dropbox
  DROPBOX = 'dropbox',
  // Phase 51: Spec 041 — Source Company Plugin: Roblox
  ROBLOX = 'roblox',
  // Phase 52: Spec 042 — Source Company Plugin: Block
  BLOCK = 'block',
  // Phase 53: Spec 043 — Source Company Plugin: Vercel
  VERCEL = 'vercel',
  // Phase 54: Spec 044 — Source Company Plugin: Affirm
  AFFIRM = 'affirm',
  // Phase 55: Spec 045 — Source Company Plugin: Klaviyo
  KLAVIYO = 'klaviyo',
  // Phase 56: Spec 046 — Source Company Plugin: Duolingo
  DUOLINGO = 'duolingo',
  // Phase 57: Spec 047 — Source Company Plugin: Brex
  BREX = 'brex',
  // Phase 58: Spec 048 — Source Company Plugin: Gusto
  GUSTO = 'gusto',
  // Phase 59: Spec 049 — Source Company Plugin: Mercury
  MERCURY = 'mercury',
  // Phase 60: Spec 050 — Source Company Plugin: Buildkite
  BUILDKITE = 'buildkite',
  // Phase 61: Spec 051 — Source Company Plugin: CircleCI
  CIRCLECI = 'circleci',
  // Phase 62: Spec 052 — Source Company Plugin: Ramp Network
  RAMPNETWORK = 'rampnetwork',
  // Phase 63: Spec 053 — Source Company Plugin: Netlify
  NETLIFY = 'netlify',
  // Phase 64: Spec 054 — Source Company Plugin: Postman
  POSTMAN = 'postman',
  // Phase 65: Spec 055 — Source Company Plugin: Toast
  TOAST = 'toast',
  // Phase 66: Spec 056 — Source Company Plugin: Webflow
  WEBFLOW = 'webflow',
  // Phase 67: Spec 057 — Source Company Plugin: ZoomInfo
  ZOOMINFO = 'zoominfo',
  // Phase 68: Spec 058 — Source Company Plugin: Attentive
  ATTENTIVE = 'attentive',
  // Phase 69: Spec 059 — Source Company Plugin: Chime
  CHIME = 'chime',
  // Phase 70: Spec 060 — Source Company Plugin: Elastic
  ELASTIC = 'elastic',
  // Phase 71: Spec 061 — Source Company Plugin: Intercom
  INTERCOM = 'intercom',
  // Phase 72: Spec 062 — Source Company Plugin: Mixpanel
  MIXPANEL = 'mixpanel',
  // Phase 73: Spec 063 — Source Company Plugin: Faire
  FAIRE = 'faire',
  // Phase 74: Spec 064 — Source Company Plugin: Scale AI
  SCALEAI = 'scaleai',
  // Phase 75: Spec 065 — Source Company Plugin: Cameo
  CAMEO = 'cameo',
  // Phase 76: Spec 066 — Source Company Plugin: Carta
  CARTA = 'carta',
  // Phase 77: Spec 067 — Source Company Plugin: ClassPass
  CLASSPASS = 'classpass',
  // Phase 78: Spec 068 — Source Company Plugin: Coursera
  COURSERA = 'coursera',
  // Phase 79: Spec 069 — Source Company Plugin: Epic Games
  EPICGAMES = 'epicgames',
  // Phase 80: Spec 070 — Source Company Plugin: Flexport
  FLEXPORT = 'flexport',
  // Phase 81: Spec 071 — Source Company Plugin: fuboTV
  FUBOTV = 'fubotv',
  // Phase 82: Spec 072 — Source Company Plugin: Glossier
  GLOSSIER = 'glossier',
  // Phase 83: Spec 073 — Source Company Plugin: Honeycomb
  HONEYCOMB = 'honeycomb',
  // Phase 84: Spec 074 — Source Company Plugin: Lattice
  LATTICE = 'lattice',
  // Phase 85: Spec 075 — Source Company Plugin: MasterClass
  MASTERCLASS = 'masterclass',
  // Phase 86: Spec 076 — Source Company Plugin: Maven Clinic
  MAVENCLINIC = 'mavenclinic',
  // Phase 87: Spec 077 — Source Company Plugin: Stitch Fix
  STITCHFIX = 'stitchfix',
  // Phase 88: Spec 078 — Source Company Plugin: Udemy
  UDEMY = 'udemy',
  // Phase 89: Spec 079 — Source Company Plugin: Bitwarden
  BITWARDEN = 'bitwarden',
  // Phase 90: Spec 080 — Source Company Plugin: Calendly
  CALENDLY = 'calendly',
  // Phase 91: Spec 081 — Source Company Plugin: DataCamp
  DATACAMP = 'datacamp',
  // Phase 92: Spec 082 — Source Company Plugin: Fivetran
  FIVETRAN = 'fivetran',
  // Phase 93: Spec 083 — Source Company Plugin: Lookout
  LOOKOUT = 'lookout',
  // Phase 94: Spec 084 — Source Company Plugin: Marqeta
  MARQETA = 'marqeta',
  // Phase 95: Spec 085 — Source Company Plugin: New Relic
  NEWRELIC = 'newrelic',
  // Phase 96: Spec 086 — Source Company Plugin: Peloton
  PELOTON = 'peloton',
  // Phase 97: Spec 087 — Source Company Plugin: Scopely
  SCOPELY = 'scopely',
  // Phase 98: Spec 088 — Source Company Plugin: Squarespace
  SQUARESPACE = 'squarespace',
  // Phase 99: Spec 089 — Source Company Plugin: Typeform
  TYPEFORM = 'typeform',
  // Phase 100: Spec 090 — Source Company Plugin: Adyen
  ADYEN = 'adyen',
  // Phase 101: Spec 091 — Source Company Plugin: Benevity
  BENEVITY = 'benevity',
  // Phase 102: Spec 092 — Source Company Plugin: BILL (billcom)
  BILLCOM = 'billcom',
  // Phase 103: Spec 093 — Source Company Plugin: Bobbie
  BOBBIE = 'bobbie',
  // Phase 104: Spec 094 — Source Company Plugin: Cerebral
  CEREBRAL = 'cerebral',
  // Phase 105: Spec 095 — Source Company Plugin: Coalition
  COALITION = 'coalition',
  // Phase 106: Spec 096 — Source Company Plugin: Dollar Shave Club
  DOLLARSHAVECLUB = 'dollarshaveclub',
  // Phase 107: Spec 097 — Source Company Plugin: HelloFresh
  HELLOFRESH = 'hellofresh',
  // Phase 108: Spec 098 — Source Company Plugin: Misfits Market
  MISFITSMARKET = 'misfitsmarket',
  // Phase 109: Spec 099 — Source Company Plugin: Monzo
  MONZO = 'monzo',
  // Phase 110: Spec 100 — Source Company Plugin: N26
  N26 = 'n26',
  // Phase 111: Spec 101 — Source Company Plugin: PlanetScale
  PLANETSCALE = 'planetscale',
  // Phase 112: Spec 102 — Source Company Plugin: SoFi
  SOFI = 'sofi',
  // Phase 113: Spec 103 — Source Company Plugin: StockX
  STOCKX = 'stockx',
  // Phase 114: Spec 104 — Source Company Plugin: sweetgreen
  SWEETGREEN = 'sweetgreen',
  // Phase 115: Spec 105 — Source Company Plugin: xAI
  XAI = 'xai',
  // Phase 116: Spec 106 — Source Company Plugin: Airtable
  AIRTABLE = 'airtable',
  // Phase 117: Spec 107 — Source Company Plugin: Amplitude
  AMPLITUDE = 'amplitude',
  // Phase 118: Spec 108 — Source Company Plugin: AssemblyAI
  ASSEMBLYAI = 'assemblyai',
  // Phase 119: Spec 109 — Source Company Plugin: Bandwidth
  BANDWIDTH = 'bandwidth',
  // Phase 120: Spec 110 — Source Company Plugin: Braze
  BRAZE = 'braze',
  // Phase 121: Spec 111 — Source Company Plugin: Constant Contact
  CONSTANTCONTACT = 'constantcontact',
  // Phase 122: Spec 112 — Source Company Plugin: Descript
  DESCRIPT = 'descript',
  // Phase 123: Spec 113 — Source Company Plugin: Fastly
  FASTLY = 'fastly',
  // Phase 124: Spec 114 — Source Company Plugin: LaunchDarkly
  LAUNCHDARKLY = 'launchdarkly',
  // Phase 125: Spec 115 — Source Company Plugin: Okta
  OKTA = 'okta',
  // Phase 126: Spec 116 — Source Company Plugin: Otter
  OTTER = 'otter',
  // Phase 127: Spec 117 — Source Company Plugin: PagerDuty
  PAGERDUTY = 'pagerduty',
  // Phase 128: Spec 118 — Source Company Plugin: Pendo
  PENDO = 'pendo',
  // Phase 129: Spec 119 — Source Company Plugin: Vonage
  VONAGE = 'vonage',
  // Phase 130: Spec 120 — Source Company Plugin: Betterment
  BETTERMENT = 'betterment',
  // Phase 131: Spec 121 — Source Company Plugin: Branch
  BRANCH = 'branch',
  // Phase 132: Spec 122 — Source Company Plugin: Chainguard
  CHAINGUARD = 'chainguard',
  // Phase 133: Spec 123 — Source Company Plugin: Checkr
  CHECKR = 'checkr',
  // Phase 134: Spec 124 — Source Company Plugin: Contentful
  CONTENTFUL = 'contentful',
  // Phase 135: Spec 125 — Source Company Plugin: Descope
  DESCOPE = 'descope',
  // Phase 136: Spec 126 — Source Company Plugin: Dialpad
  DIALPAD = 'dialpad',
  // Phase 137: Spec 127 — Source Company Plugin: Doximity
  DOXIMITY = 'doximity',
  // Phase 138: Spec 128 — Source Company Plugin: Dremio
  DREMIO = 'dremio',
  // Phase 139: Spec 129 — Source Company Plugin: Justworks
  JUSTWORKS = 'justworks',
  // Phase 140: Spec 130 — Source Company Plugin: Melio
  MELIO = 'melio',
  // Phase 141: Spec 131 — Source Company Plugin: Modern Health
  MODERNHEALTH = 'modernhealth',
  // Phase 142: Spec 132 — Source Company Plugin: Opendoor
  OPENDOOR = 'opendoor',
  // Phase 143: Spec 133 — Source Company Plugin: Oscar
  OSCAR = 'oscar',
  // Phase 144: Spec 134 — Source Company Plugin: Starburst
  STARBURST = 'starburst',
  // Phase 145: Spec 135 — Source Company Plugin: Axon
  AXON = 'axon',
  // Phase 146: Spec 136 — Source Company Plugin: BEAM
  BEAM = 'beam',
  // Phase 147: Spec 137 — Source Company Plugin: BigID
  BIGID = 'bigid',
  // Phase 148: Spec 138 — Source Company Plugin: Blend
  BLEND = 'blend',
  // Phase 149: Spec 139 — Source Company Plugin: Bloomreach
  BLOOMREACH = 'bloomreach',
  // Phase 150: Spec 140 — Source Company Plugin: Celonis
  CELONIS = 'celonis',
  // Phase 151: Spec 141 — Source Company Plugin: ComplyAdvantage
  COMPLYADVANTAGE = 'complyadvantage',
  // Phase 152: Spec 142 — Source Company Plugin: Conviva
  CONVIVA = 'conviva',
  // Phase 153: Spec 143 — Source Company Plugin: Cribl
  CRIBL = 'cribl',
  // Phase 154: Spec 144 — Source Company Plugin: Earnest
  EARNEST = 'earnest',
  // Phase 155: Spec 145 — Source Company Plugin: ExpressVPN
  EXPRESSVPN = 'expressvpn',
  // Phase 156: Spec 146 — Source Company Plugin: Fairmarkit
  FAIRMARKIT = 'fairmarkit',
  // Phase 157: Spec 147 — Source Company Plugin: Formlabs
  FORMLABS = 'formlabs',
  // Phase 158: Spec 148 — Source Company Plugin: Founders
  FOUNDERS = 'founders',
  // Phase 159: Spec 149 — Source Company Plugin: Fox
  FOX = 'fox',
  // Phase 160: Spec 150 — Source Company Plugin: GoCardless
  GOCARDLESS = 'gocardless',
  // Phase 161: Spec 151 — Source Company Plugin: GoFundMe
  GOFUNDME = 'gofundme',
  // Phase 162: Spec 152 — Source Company Plugin: Alma
  ALMA = 'alma',
  // Phase 163: Spec 153 — Source Company Plugin: Bird
  BIRD = 'bird',
  // Phase 164: Spec 154 — Source Company Plugin: BitGo
  BITGO = 'bitgo',
  // Phase 165: Spec 155 — Source Company Plugin: Collective Health
  COLLECTIVEHEALTH = 'collectivehealth',
  // Phase 166: Spec 156 — Source Company Plugin: DeepMind
  DEEPMIND = 'deepmind',
  // Phase 167: Spec 157 — Source Company Plugin: Indigo
  INDIGO = 'indigo',
  // Phase 168: Spec 158 — Source Company Plugin: Instabase
  INSTABASE = 'instabase',
  // Phase 169: Spec 159 — Source Company Plugin: Iterable
  ITERABLE = 'iterable',
  // Phase 170: Spec 160 — Source Company Plugin: Labelbox
  LABELBOX = 'labelbox',
  // Phase 171: Spec 161 — Source Company Plugin: Markforged
  MARKFORGED = 'markforged',
  // Phase 172: Spec 162 — Source Company Plugin: Maven
  MAVEN = 'maven',
  // Phase 173: Spec 163 — Source Company Plugin: Netskope
  NETSKOPE = 'netskope',
  // Phase 174: Spec 164 — Source Company Plugin: Postscript
  POSTSCRIPT = 'postscript',
  // Phase 175: Spec 165 — Source Company Plugin: Cresta
  CRESTA = 'cresta',
  // Phase 176: Spec 166 — Source Company Plugin: Quanata
  QUANATA = 'quanata',
  // Phase 177: Spec 167 — Source Company Plugin: Recharge
  RECHARGE = 'recharge',
  // Phase 178: Spec 168 — Source Company Plugin: Samsara
  SAMSARA = 'samsara',
  // Phase 179: Spec 169 — Source Company Plugin: Sezzle
  SEZZLE = 'sezzle',
  // Phase 180: Spec 170 — Source Company Plugin: Shopmonkey
  SHOPMONKEY = 'shopmonkey',
  // Phase 181: Spec 171 — Source Company Plugin: SimpliSafe
  SIMPLISAFE = 'simplisafe',
  // Phase 182: Spec 172 — Source Company Plugin: Symphony
  SYMPHONY = 'symphony',
  // Phase 183: Spec 173 — Source Company Plugin: Tatari
  TATARI = 'tatari',
  // Phase 184: Spec 174 — Source Company Plugin: Textio
  TEXTIO = 'textio',
  // Phase 185: Spec 175 — Source Company Plugin: AccuWeather
  ACCUWEATHER = 'accuweather',
  // Phase 186: Spec 176 — Source Company Plugin: ACI Learning
  ACILEARNING = 'acilearning',
  // Phase 187: Spec 177 — Source Company Plugin: Ackermann Group
  ACKERMANNGROUP = 'ackermanngroup',
  // Phase 188: Spec 178 — Source Company Plugin: ACLU
  ACLU = 'aclu',
  // Phase 189: Spec 179 — Source Company Plugin: ACOG
  ACOG = 'acog',
  // Phase 190: Spec 180 — Source Company Plugin: aCommerce
  ACOMMERCE = 'acommerce',
  // Phase 191: Spec 181 — Source Company Plugin: ACP
  ACP = 'acp',
  // Phase 192: Spec 182 — Source Company Plugin: Acquia
  ACQUIA = 'acquia',
  // Phase 193: Spec 183 — Source Company Plugin: Acrisure Innovation
  ACRISUREINNOVATION = 'acrisureinnovation',
  // Phase 194: Spec 184 — Source Company Plugin: Acryl Data
  ACRYLDATA = 'acryldata',
  // Phase 195: Spec 185 — Source Company Plugin: Acumen
  ACUMEN = 'acumen',
  // Phase 196: Spec 186 — Source Company Plugin: Acurus Solutions
  ACURUSSOLUTIONS = 'acurussolutions',
  // Phase 197: Spec 187 — Source Company Plugin: Adaptive Biotechnologies
  ADAPTIVEBIOTECHNOLOGIES = 'adaptivebiotechnologies',
  // Phase 198: Spec 188 — Source Company Plugin: Adaptive Financial Consulting
  ADAPTIVEFINANCIALCONSULTING = 'adaptivefinancialconsulting',
  // Phase 199: Spec 189 — Source Company Plugin: the Ad Council
  ADCOUNCIL = 'adcouncil',
  // Phase 200: Spec 190 — Source Company Plugin: Addepar
  ADDEPAR1 = 'addepar1',
  // Phase 201: Spec 191 — Source Company Plugin: Adelphi Research
  ADELPHIRESEARCH = 'adelphiresearch',
  // Phase 202: Spec 192 — Source Company Plugin: Advanced Space
  ADVANCEDSPACE = 'advancedspace',
  // Phase 203: Spec 193 — Source Company Plugin: Advanced Technology Services
  ADVANCEDTECHNOLOGYSERVICES = 'advancedtechnologyservices',
  // Phase 204: Spec 194 — Source Company Plugin: Advocate Construction
  ADVOCATECONSTRUCTION = 'advocateconstruction',
  // Phase 205: Spec 195 — Source Company Plugin: AEC
  AEC = 'aec',
  // Phase 206: Spec 196 — Source Company Plugin: Aechelon Technology
  AECHELONTECHNOLOGY = 'aechelontechnology',
  // Phase 207: Spec 197 — Source Company Plugin: Aegis Ventures
  AEGISVENTURES = 'aegisventures',
  // Phase 208: Spec 198 — Source Company Plugin: Aerospike
  AEROSPIKE = 'aerospike',
  // Phase 209: Spec 199 — Source Company Plugin: AE Studio
  AESTUDIO = 'aestudio',
  // Phase 210: Spec 200 — Source Company Plugin: Affinidi
  AFFINIDI = 'affinidi',
  // Phase 211: Spec 201 — Source Company Plugin: Affinity.co
  AFFINITY = 'affinity',
  // Phase 212: Spec 202 — Source Company Plugin: Afresh
  AFRESH = 'afresh',
  // Phase 213: Spec 203 — Source Company Plugin: AfterShip
  AFTERSHIP = 'aftership',
  // Phase 214: Spec 204 — Source Company Plugin: AG1
  AG1 = 'ag1',
  // Phase 215: Spec 205 — Source Company Plugin: Age Bold
  AGEBOLD = 'agebold',
  // Phase 216: Spec 206 — Source Company Plugin: AGE Solutions
  AGECAREERS = 'agecareers',
  // Phase 217: Spec 207 — Source Company Plugin: WITHIN
  AGENCYWITHIN = 'agencywithin',
  // Phase 218: Spec 208 — Source Company Plugin: Agilisys
  AGILISYS = 'agilisys',
  // Phase 219: Spec 209 — Source Company Plugin: Agilysys
  AGILYSYS = 'agilysys',
  // Phase 220: Spec 210 — Source Company Plugin: Agoda
  AGODA = 'agoda',
  // Phase 221: Spec 211 — Source Company Plugin: AgWest Farm Credit
  AGWESTFARMCREDIT = 'agwestfarmcredit',
  // Phase 222: Spec 212 — Source Company Plugin: Ahrefs
  AHREFSJOBS = 'ahrefsjobs',
  // Phase 223: Spec 213 — Source Company Plugin: AIFT
  AIFT = 'aift',
  // Phase 224: Spec 214 — Source Company Plugin: Airia
  AIRIA = 'airia',
  // Phase 225: Spec 215 — Source Company Plugin: Air North
  AIRNORTH = 'airnorth',
  // Phase 226: Spec 216 — Source Company Plugin: AirSculpt
  AIRSCULPT = 'airsculpt',
  // Phase 227: Spec 217 — Source Company Plugin: Airspace 
  AIRSPACE = 'airspace',
  // Phase 228: Spec 218 — Source Company Plugin: AirTrunk
  AIRTRUNK = 'airtrunk',
  // Phase 229: Spec 219 — Source Company Plugin: Aisera
  AISERAJOBS = 'aiserajobs',
  // Phase 230: Spec 220 — Source Company Plugin: AI Squared
  AISQUARED = 'aisquared',
  // Phase 231: Spec 221 — Source Company Plugin: Akido
  AKIDOLABS = 'akidolabs',
  // Phase 232: Spec 222 — Source Company Plugin: AKKO
  AKKO = 'akko',
  // Phase 233: Spec 223 — Source Company Plugin: Akoya
  AKOYA = 'akoya',
  // Phase 234: Spec 224 — Source Company Plugin: Akuity
  AKUITY = 'akuity',
  // Phase 235: Spec 225 — Source Company Plugin: Alamar Biosciences
  ALAMARBIOSCIENCES = 'alamarbiosciences',
  // Phase 236: Spec 226 — Source Company Plugin: Alarm.com
  ALARMCOM = 'alarmcom',
  // Phase 237: Spec 227 — Source Company Plugin: Albedo
  ALBEDO = 'albedo',
  // Phase 238: Spec 228 — Source Company Plugin: AlertMedia
  ALERTMEDIA = 'alertmedia',
  // Phase 239: Spec 229 — Source Company Plugin: Algolia
  ALGOLIA = 'algolia',
  // Phase 240: Spec 230 — Source Company Plugin: A-LIGN External
  ALIGN = 'align',
  // Phase 241: Spec 231 — Source Company Plugin: Align Communications
  ALIGN46 = 'align46',
  // Phase 242: Spec 232 — Source Company Plugin: Cortica - Neurodevelopmental
  ALLCAREERS = 'allcareers',
  // Phase 243: Spec 233 — Source Company Plugin: Allen Control Systems
  ALLENCONTROLSYSTEMS = 'allencontrolsystems',
  // Phase 244: Spec 234 — Source Company Plugin: Allen Integrated Solutions
  ALLENINTEGRATEDSOLUTIONS = 'allenintegratedsolutions',
  // Phase 245: Spec 235 — Source Company Plugin: Alliance Defending Freedom
  ALLIANCEDEFENDINGFREEDOM = 'alliancedefendingfreedom',
  // Phase 246: Spec 236 — Source Company Plugin: Aspire Living & Learning 
  ALLINC = 'allinc',
  // Phase 247: Spec 237 — Source Company Plugin: AWL
  ALLWEBLEADS = 'allwebleads',
  // Phase 248: Spec 238 — Source Company Plugin: Ally Behavior Centers
  ALLYBEHAVIORCENTERS = 'allybehaviorcenters',
  // Phase 249: Spec 239 — Source Company Plugin: Alpaca 
  ALPACA = 'alpaca',
  // Phase 250: Spec 240 — Source Company Plugin: Alpha FMC - UK 
  ALPHAFMC = 'alphafmc',
  // Phase 251: Spec 241 — Source Company Plugin: Alpha Financial Markets Consulting
  ALPHAFMCROLES = 'alphafmcroles',
  // Phase 252: Spec 242 — Source Company Plugin: AlphaGrep Securities
  ALPHAGREPSECURITIES = 'alphagrepsecurities',
  // Phase 253: Spec 243 — Source Company Plugin: AlphaSense
  ALPHASENSE = 'alphasense',
  // Phase 254: Spec 244 — Source Company Plugin: AlphaSense India
  ALPHASENSEINDIA = 'alphasenseindia',
  // Phase 255: Spec 245 — Source Company Plugin: Alt
  ALT = 'alt',
  // Phase 256: Spec 246 — Source Company Plugin: Altana 
  ALTANAAI = 'altanaai',
  // Phase 257: Spec 247 — Source Company Plugin: ALTEN Technology USA
  ALTENTECHNOLOGYUSA = 'altentechnologyusa',
  // Phase 258: Spec 248 — Source Company Plugin: Altium
  ALTIUM = 'altium',
  // Phase 259: Spec 249 — Source Company Plugin: Altos Labs
  ALTOSLABS = 'altoslabs',
  // Phase 260: Spec 250 — Source Company Plugin: AltScore
  ALTSCORE = 'altscore',
  // Phase 261: Spec 251 — Source Company Plugin: ALU
  ALU = 'alu',
  // Phase 262: Spec 252 — Source Company Plugin: Alumni Ventures
  ALUMNIVENTURES = 'alumniventures',
  // Phase 263: Spec 253 — Source Company Plugin: Alveole
  ALVEOLE = 'alveole',
  // Phase 264: Spec 254 — Source Company Plugin: ALX Africa
  ALXAFRICA = 'alxafrica',
  // Phase 265: Spec 255 — Source Company Plugin: Amae Health
  AMAEHEALTH = 'amaehealth',
  // Phase 266: Spec 256 — Source Company Plugin: AMAROK
  AMAROK = 'amarok',
  // Phase 267: Spec 257 — Source Company Plugin: Ambient Enterprises
  AMBIENTENTERPRISES = 'ambiententerprises',
  // Phase 268: Spec 258 — Source Company Plugin: Amca
  AMCA = 'amca',
  // Phase 269: Spec 259 — Source Company Plugin: AMEND Consulting
  AMENDCONSULTING = 'amendconsulting',
  // Phase 270: Spec 260 — Source Company Plugin: American Capital Group
  AMERICANCAPITALGROUP = 'americancapitalgroup',
  // Phase 271: Spec 261 — Source Company Plugin: American Institute
  AMERICANINSTITUTE = 'americaninstitute',
  // Phase 272: Spec 262 — Source Company Plugin: American Institutes for Research
  AMERICANINSTITUTESFORRESEARCH = 'americaninstitutesforresearch',
  // Phase 273: Spec 263 — Source Company Plugin: FIS® Amount™
  AMOUNT = 'amount',
  // Phase 274: Spec 264 — Source Company Plugin: Amtech Software
  AMTECHSOFTWARE = 'amtechsoftware',
  // Phase 275: Spec 265 — Source Company Plugin: Amwell
  AMWELL = 'amwell',
  // Phase 276: Spec 266 — Source Company Plugin: Amylyx Pharmaceuticals
  AMYLYX = 'amylyx',
  // Phase 277: Spec 267 — Source Company Plugin: Anaplan
  ANAPLAN = 'anaplan',
  ANATAR = 'anatar',
  // Phase 278: Spec 268 — Source Company Plugin: Anchanto
  ANCHANTO = 'anchanto',
  // Phase 279: Spec 269 — Source Company Plugin: Schwarzman Animal Medical Center
  ANIMALMEDICALCENTER = 'animalmedicalcenter',
  // Phase 280: Spec 270 — Source Company Plugin: ANINE BING
  ANINEBING = 'aninebing',
  // Phase 281: Spec 271 — Source Company Plugin: Ansa
  ANSA = 'ansa',
  // Phase 282: Spec 272 — Source Company Plugin: Antenna
  ANTENNA = 'antenna',
  // Phase 283: Spec 273 — Source Company Plugin: Anteriad 
  ANTERIAD = 'anteriad',
  // Phase 284: Spec 274 — Source Company Plugin: Anteris Technologies
  ANTERISTECH = 'anteristech',
  // Phase 285: Spec 275 — Source Company Plugin: Antora Energy
  ANTORA = 'antora',
  // Phase 286: Spec 276 — Source Company Plugin: AOTI
  AOTI = 'aoti',
  // Phase 287: Spec 277 — Source Company Plugin: Apaleo
  APALEO = 'apaleo',
  // Phase 288: Spec 278 — Source Company Plugin: Apartment Life
  APARTMENTLIFE = 'apartmentlife',
  // Phase 289: Spec 279 — Source Company Plugin: Apera AI Inc
  APERAAIINC = 'aperaaiinc',
  // Phase 290: Spec 280 — Source Company Plugin: Aperia
  APERIASOLUTIONS = 'aperiasolutions',
  // Phase 291: Spec 281 — Source Company Plugin: Apex Companies
  APEXCOMPANIES = 'apexcompanies',
  // Phase 292: Spec 282 — Source Company Plugin: Apex Companies - CSW
  APEXCOMPANIESCSW = 'apexcompaniescsw',
  // Phase 293: Spec 283 — Source Company Plugin: Apiiro
  APIIRO = 'apiiro',
  // Phase 294: Spec 284 — Source Company Plugin: apiphani
  APIPHANI = 'apiphani',
  // Phase 295: Spec 285 — Source Company Plugin: MrBeast Contract Jobs
  APLAYERS = 'aplayers',
  // Phase 296: Spec 286 — Source Company Plugin: Apogee Therapeutics
  APOGEETHERAPEUTICS = 'apogeetherapeutics',
  // Phase 297: Spec 287 — Source Company Plugin: Apollo Behavior 
  APOLLOBEHAVIORSERVICES = 'apollobehaviorservices',
  // Phase 298: Spec 288 — Source Company Plugin: Apollo.io
  APOLLOIO = 'apolloio',
  // Phase 299: Spec 289 — Source Company Plugin: APPARATUS
  APPARATUS = 'apparatus',
  // Phase 300: Spec 290 — Source Company Plugin: AppDirect
  APPDIRECT = 'appdirect',
  // Phase 301: Spec 291 — Source Company Plugin: Appfire
  APPFIRE = 'appfire',
  // Phase 302: Spec 292 — Source Company Plugin: Appian Corporation 
  APPIAN = 'appian',
  // Phase 303: Spec 293 — Source Company Plugin: Appier
  APPIER = 'appier',
  // Phase 304: Spec 294 — Source Company Plugin: AppleTree Prep
  APPLETREEPREP = 'appletreeprep',
  // Phase 305: Spec 295 — Source Company Plugin: Aktos
  APPLYTOAKTOS = 'applytoaktos',
  // Phase 306: Spec 297 — Source ATS Plugin: Cornerstone OnDemand (CSOD)
  CORNERSTONE = 'cornerstone',
  // Phase 307: Spec 298 — Source ATS Plugin: Dayforce (Ceridian Dayforce HCM)
  DAYFORCE = 'dayforce',
  // Phase 308: Spec 299 — Source ATS Plugin: Zoho Recruit
  //   (the ZOHORECRUIT enum member already exists above near EIGHTFOLD;
  //    Spec 299 wires the previously-orphaned member to a real plugin.)
  // Phase 309: Spec 300 — Source ATS Plugin: ClearCompany
  CLEARCOMPANY = 'clearcompany',
  // Phase 310: Spec 301 — Source ATS Plugin: Niceboard (hosted job-board platform)
  NICEBOARD = 'niceboard',
  // Phase 311: Spec 302 — Source ATS Plugin: GoHire
  GOHIRE = 'gohire',
  // Phase 312: Spec 303 — Source ATS Plugin: Recooty
  RECOOTY = 'recooty',
  // Phase 313: Spec 304 — Source ATS Plugin: Polymer
  POLYMER = 'polymer',
  // Phase 314: Spec 305 — Source ATS Plugin: VivaHR (AvaHR rebrand)
  VIVAHR = 'vivahr',
  // Phase 315: Spec 306 — Source ATS Plugin: Occupop
  OCCUPOP = 'occupop',
  // Phase 316: Spec 307 — Source ATS Plugin: JobAdder
  JOBADDER = 'jobadder',
  // Phase 317: Spec 308 — Source ATS Plugin: Hireology
  HIREOLOGY = 'hireology',
  // Phase 318: Spec 309 — Source ATS Plugin: Applied (beapplied.com)
  APPLIED = 'applied',
  // Phase 319: Spec 310 — Source ATS Plugin: CATS (catsone.com)
  CATSONE = 'catsone',
  // Phase 320: Spec 311 — Source ATS Plugin: Recruit CRM (recruitcrm.io)
  RECRUITCRM = 'recruitcrm',
  // Phase 321: Spec 312 — Source ATS Plugin: Vincere (vincere.io)
  VINCERE = 'vincere',
  // Phase 322: Spec 313 — Source ATS Plugin: Factorial (factorialhr.com)
  FACTORIAL = 'factorial',
  // Phase 323: Spec 314 — Source ATS Plugin: Workstream (workstream.us)
  WORKSTREAM = 'workstream',
  // Phase 324: Spec 315 — Source ATS Plugin: Harri (harri.com)
  HARRI = 'harri',
  // Phase 325: Spec 316 — Source ATS Plugin: Tribepad (tribepad.com)
  TRIBEPAD = 'tribepad',
  // Phase 326: Spec 317 — Source ATS Plugin: Eploy (eploy.co.uk)
  EPLOY = 'eploy',
  // Phase 327: Spec 318 — Source ATS Plugin: Oorwin (oorwin.com)
  OORWIN = 'oorwin',
  // Phase 328: Spec 319 — Source ATS Plugin: Ceipal (ceipal.com)
  CEIPAL = 'ceipal',
  // Phase 329: Spec 320 — Source ATS Plugin: Softgarden (softgarden.io)
  SOFTGARDEN = 'softgarden',
  // Phase 330: Spec 321 — Source ATS Plugin: Recruitis (recruitis.io)
  RECRUITIS = 'recruitis',
  // Phase 331: Spec 322 — Source ATS Plugin: Flatchr (flatchr.io)
  FLATCHR = 'flatchr',
  // Phase 332: Spec 323 — Source ATS Plugin: Jobsoid (jobsoid.com)
  JOBSOID = 'jobsoid',
  // Phase 333: Spec 324 — Source ATS Plugin: Skeeled (skeeled.com)
  SKEELED = 'skeeled',
  // Phase 334: Spec 325 — Source ATS Plugin: Teamdash (teamdash.com)
  TEAMDASH = 'teamdash',
  // Phase 335: Spec 326 — Source ATS Plugin: DigitalRecruiters (digitalrecruiters.com)
  DIGITALRECRUITERS = 'digitalrecruiters',
  // Phase 336: Spec 327 — Source ATS Plugin: Concludis (concludis.de)
  CONCLUDIS = 'concludis',
  // Phase 337: Spec 328 — Source ATS Plugin: rexx systems (rexx-systems.com)
  REXX = 'rexx',
  // Phase 338: Spec 329 — Source ATS Plugin: PCRecruiter (pcrecruiter.net)
  PCRECRUITER = 'pcrecruiter',
  // Phase 339: Spec 330 — Source ATS Plugin: Prescreen (prescreen.io)
  PRESCREEN = 'prescreen',
  // Phase 340: Spec 331 — Source ATS Plugin: Traffit (traffit.com)
  TRAFFIT = 'traffit',
  // Phase 341: Spec 332 — Source ATS Plugin: HR-ON Recruit (hr-on.com)
  HRON = 'hron',
  // Phase 342: Spec 333 — Source ATS Plugin: Sage HR (sage.hr)
  SAGEHR = 'sagehr',
  // Phase 343: Spec 334 — Source ATS Plugin: CareerPlug (careerplug.com)
  CAREERPLUG = 'careerplug',
  // Phase 344: Spec 335 — Source ATS Plugin: Webcruiter (webcruiter.com)
  WEBCRUITER = 'webcruiter',
  // Phase 345: Spec 336 — Source ATS Plugin: d.vinci (dvinci-hr.com)
  DVINCI = 'dvinci',
  // Phase 346: Spec 337 — Source ATS Plugin: Heyrecruit (heyrecruit.de)
  HEYRECRUIT = 'heyrecruit',
  // Phase 347: Spec 338 — Source ATS Plugin: TalentAdore (talentadore.com)
  TALENTADORE = 'talentadore',
  // Phase 348: Spec 339 — Source ATS Plugin: JobDiva (jobdiva.com)
  JOBDIVA = 'jobdiva',
  // Phase 349: Spec 340 — Source ATS Plugin: EasyCruit (easycruit.com)
  EASYCRUIT = 'easycruit',
  // Phase 350: Spec 341 — Source ATS Plugin: Varbi (varbi.com)
  VARBI = 'varbi',
  // Phase 351: Spec 342 — Source ATS Plugin: Talentsoft (talentsoft.com)
  TALENTSOFT = 'talentsoft',
  // Phase 352: Spec 343 — Source ATS Plugin: Beetween (beetween.com)
  BEETWEEN = 'beetween',
  // Phase 353: Spec 344 — Source ATS Plugin: ApplicantPro (applicantpro.com)
  APPLICANTPRO = 'applicantpro',
  // Phase 354: Spec 345 — Source ATS Plugin: Darwinbox (darwinbox.com)
  DARWINBOX = 'darwinbox',
  // Phase 355: Spec 346 — Source ATS Plugin: TalentReef (talentreef.com)
  TALENTREEF = 'talentreef',
  // Phase 356: Spec 347 — Source ATS Plugin: ApplicantStack (applicantstack.com)
  APPLICANTSTACK = 'applicantstack',
  // Phase 357: Spec 348 — Source ATS Plugin: Paycor Recruiting (paycor.com)
  PAYCOR = 'paycor',
  // Phase 358: Spec 349 — Source ATS Plugin: Arcoro (arcoro.com / birddoghr.com)
  ARCORO = 'arcoro',
  // Phase 359: Spec 350 — Source ATS Plugin: ReachMee (reachmee.com)
  REACHMEE = 'reachmee',
  // Phase 360: Spec 351 — Source ATS Plugin: Jobtrain (jobtrain.co.uk)
  JOBTRAIN = 'jobtrain',
  // Phase 361: Spec 352 — Source ATS Plugin: Avionté (avionte.com)
  AVIONTE = 'avionte',
  // Phase 362: Spec 353 — Source ATS Plugin: ExactHire (exacthire.com)
  EXACTHIRE = 'exacthire',
  // Phase 363: Spec 354 — Source ATS Plugin: Hireful (hireful.com)
  HIREFUL = 'hireful',
  // Phase 364: Spec 355 — Source ATS Plugin: Paycom (paycomonline.net)
  PAYCOM = 'paycom',
  // Phase 365: Spec 356 — Source ATS Plugin: PageUp (pageuppeople.com)
  PAGEUP = 'pageup',
  // Phase 366: Spec 357 — Source ATS Plugin: BrassRing (sjobs.brassring.com)
  BRASSRING = 'brassring',
  // Phase 367: Spec 358 — Source ATS Plugin: Namely (namely.com)
  NAMELY = 'namely',
  // Phase 368: Spec 359 — Source ATS Plugin: TempWorks (jobboard.ontempworks.com)
  TEMPWORKS = 'tempworks',
  // Phase 369: Spec 360 — Source ATS Plugin: Keka (keka.com)
  KEKA = 'keka',
  // Phase 370: Spec 361 — Source ATS Plugin: Snaphunt (snaphunt.com)
  SNAPHUNT = 'snaphunt',
  // Phase 371: Spec 362 — Source ATS Plugin: Dover (dover.com)
  DOVER = 'dover',
  // Phase 372: Spec 363 — Source ATS Plugin: Paychex (paychex.com)
  PAYCHEX = 'paychex',
  // Phase 373: Spec 364 — Source ATS Plugin: PyjamaHR (jobs.pyjamahr.com)
  PYJAMAHR = 'pyjamahr',
  // Phase 374: Spec 365 — Source ATS Plugin: LiveHire (livehire.com)
  LIVEHIRE = 'livehire',
  // Phase 375: Spec 366 — Source ATS Plugin: Scout Talent (applynow.net.au)
  SCOUTTALENT = 'scouttalent',
  // Phase 376: Spec 367 — Source ATS Plugin: TurboHire (turbohire.co)
  TURBOHIRE = 'turbohire',
  // Phase 377: Spec 368 — Source ATS Plugin: Zwayam (zwayam.com)
  ZWAYAM = 'zwayam',
  // Phase 378: Spec 369 — Source ATS Plugin: TrackerRMS (tracker-rms.com)
  TRACKERRMS = 'trackerrms',
  // Phase 379: Spec 370 — Source ATS Plugin: AkkenCloud (akkencloud.com)
  AKKENCLOUD = 'akkencloud',
  // Phase 380: Spec 371 — Source ATS Plugin: Mindscope (mindscope.com)
  MINDSCOPE = 'mindscope',
  // Phase 381: Spec 372 — Source ATS Plugin: HiBob (hibob.com)
  HIBOB = 'hibob',
  // Phase 382: Spec 373 — Source ATS Plugin: Taleez (taleez.com)
  TALEEZ = 'taleez',
  // Phase 383: Spec 374 — Source ATS Plugin: Softy (softy.pro)
  SOFTY = 'softy',
  // Phase 384: Spec 375 — Source ATS Plugin: In-recruiting / Intervieweb (intervieweb.it)
  INRECRUITING = 'inrecruiting',
  // Phase 385: Spec 376 — Source ATS Plugin: Altamira (altamirahrm.com)
  ALTAMIRA = 'altamira',
  // Phase 386: Spec 377 — Source ATS Plugin: Oleeo (tal.net)
  OLEEO = 'oleeo',
  // Phase 387: Spec 378 — Source ATS Plugin: Hireserve (hireserve.com)
  HIRESERVE = 'hireserve',
  // Phase 388: Spec 379 — Source ATS Plugin: Carerix (carerix.com)
  CARERIX = 'carerix',
  // Phase 389: Spec 380 — Source ATS Plugin: OTYS (otys.com)
  OTYS = 'otys',
  // Phase 390: Spec 381 — Source ATS Plugin: Umantis / Haufe Talent (umantis.com)
  UMANTIS = 'umantis',
  // Phase 391: Spec 382 — Source ATS Plugin: Bizneo HR (bizneo.com)
  BIZNEO = 'bizneo',
  // Phase 392: Spec 383 — Source ATS Plugin: CleverConnect (cleverconnect.com)
  CLEVERCONNECT = 'cleverconnect',
  // Phase 393: Spec 384 — Source ATS Plugin: Emply / Visma (emply.com)
  EMPLY = 'emply',
  // Phase 394: Spec 385 — Source ATS Plugin: Gupy (gupy.io)
  GUPY = 'gupy',
  // Phase 395: Spec 386 — Source ATS Plugin: Welcome to the Jungle (welcometothejungle.com)
  WTTJ = 'wttj',
  // Phase 396: Spec 387 — Source ATS Plugin: MokaHR (mokahr.com)
  MOKAHR = 'mokahr',
  // Phase 397: Spec 388 — Source ATS Plugin: ELMO (elmo.com.au)
  ELMO = 'elmo',
  // Phase 398: Spec 389 — Source ATS Plugin: isolved Hire (isolvedhire.com)
  ISOLVED = 'isolved',
  // Phase 399: Spec 390 — Source ATS Plugin: BeeSite / Milch & Zucker (beesite.de)
  BEESITE = 'beesite',
  // Phase 400: Spec 391 — Source ATS Plugin: Greeting (greetinghr.com)
  GREETING = 'greeting',
  // Phase 401: Spec 392 — Source ATS Plugin: PeopleFluent (peoplefluent.com)
  PEOPLEFLUENT = 'peoplefluent',
  // Phase 402: Spec 393 — Source ATS Plugin: Sólides (solides.com.br)
  SOLIDES = 'solides',
  // Phase 403: Spec 394 — Source ATS Plugin: Jobtoolz (jobtoolz.com)
  JOBTOOLZ = 'jobtoolz',
  // Phase 404: Spec 395 — Source ATS Plugin: Hirehive (hirehive.com)
  HIREHIVE = 'hirehive',
  // Phase 405: Spec 396 — Source ATS Plugin: Eddy (eddy.com)
  EDDY = 'eddy',
  // Phase 406: Spec 397 — Source ATS Plugin: PeopleStrong (peoplestrong.com)
  PEOPLESTRONG = 'peoplestrong',
  // Phase 407: Spec 398 — Source ATS Plugin: Zimyo (zimyo.com)
  ZIMYO = 'zimyo',
  // Phase 408: Spec 399 — Source ATS Plugin: GreytHR (greythr.com)
  GREYTHR = 'greythr',
  // Phase 409: Spec 400 — Source ATS Plugin: Recruitly (recruitly.io)
  RECRUITLY = 'recruitly',
  // Phase 410: Spec 401 — Source ATS Plugin: Sage People (sage.com/people)
  SAGEPEOPLE = 'sagepeople',
  // Phase 411: Spec 402 — Source ATS Plugin: Cezanne HR (cezannehr.com)
  CEZANNE = 'cezanne',
  // Phase 412: Spec 403 — Source ATS Plugin: Workforce.com (workforce.com)
  WORKFORCE = 'workforce',
  // Phase 413: Spec 404 — Source ATS Plugin: HR Partner (hrpartner.io)
  HRPARTNER = 'hrpartner',
  // Phase 414: Spec 405 — Source ATS Plugin: Apploi (apploi.com)
  APPLOI = 'apploi',
  // Phase 415: Spec 406 — Source ATS Plugin: Kenjo (kenjo.io)
  KENJO = 'kenjo',
  // Phase 416: Spec 407 — Source ATS Plugin: Sesame HR (sesamehr.com)
  SESAMEHR = 'sesamehr',
  // Phase 417: Spec 408 — Source ATS Plugin: HROne (hrone.cloud) — distinct from HR-ON Recruit (HRON)
  HRONE = 'hrone',
  // Phase 418: Spec 409 — Source ATS Plugin: Workwise (workwise.io)
  WORKWISE = 'workwise',
  // Phase 419: Spec 410 — Source ATS Plugin: Recruiteze (recruiteze.com)
  RECRUITEZE = 'recruiteze',
  // Phase 420: Spec 411 — Source ATS Plugin: Sense (sensehq.com)
  SENSE = 'sense',
  // Phase 421: Spec 412 — Source ATS Plugin: Radancy (radancy.com)
  RADANCY = 'radancy',
  // Phase 422: Spec 413 — Source ATS Plugin: Beamery (beamery.com)
  BEAMERY = 'beamery',
  // Phase 423: Spec 414 — Source ATS Plugin: Symphony Talent (symphonytalent.com)
  SYMPHONYTALENT = 'symphonytalent',
  // Phase 424: Spec 415 — Source ATS Plugin: Employment Hero (employmenthero.com)
  EMPLOYMENTHERO = 'employmenthero',
  // Phase 425: Spec 416 — Source ATS Plugin: Talentera (talentera.com)
  TALENTERA = 'talentera',
  // Phase 426: Spec 417 — Source ATS Plugin: Subscribe-HR (subscribe-hr.com.au)
  SUBSCRIBEHR = 'subscribehr',
  // Phase 427: Spec 418 — Source ATS Plugin: Roubler (roubler.com)
  ROUBLER = 'roubler',
  // Phase 428: Spec 419 — Source ATS Plugin: Expr3ss (expr3ss.com)
  EXPR3SS = 'expr3ss',
  // Phase 429: Spec 420 — Source ATS Plugin: Access PeopleHR (peoplehr.com)
  PEOPLEHR = 'peoplehr',
  // Phase 430: Spec 421 — Source ATS Plugin: Breathe HR (breathehr.com)
  BREATHEHR = 'breathehr',
  // Phase 431: Spec 422 — Source ATS Plugin: VidCruiter (vidcruiter.com)
  VIDCRUITER = 'vidcruiter',
  // Phase 432: Spec 423 — Source ATS Plugin: Sympa (sympa.com)
  SYMPA = 'sympa',
  // Phase 433: Spec 424 — Source ATS Plugin: CVWarehouse (cvwarehouse.com)
  CVWAREHOUSE = 'cvwarehouse',
  // Phase 434: Spec 425 — Source ATS Plugin: Connexys (connexys.com) — distinct from Bullhorn (BULLHORN)
  CONNEXYS = 'connexys',
  // Phase 435: Spec 426 — Source ATS Plugin: HReasily (hreasily.com)
  HREASILY = 'hreasily',
  // Phase 436: Spec 427 — Source Company Plugin: Gemini
  GEMINI = 'gemini',
  // Phase 437: Spec 428 — Source Company Plugin: Ripple
  RIPPLE = 'ripple',
  // Phase 438: Spec 429 — Source Company Plugin: Abnormal Security
  ABNORMALSECURITY = 'abnormalsecurity',
  // Phase 439: Spec 430 — Source Company Plugin: Hightouch
  HIGHTOUCH = 'hightouch',
  // Phase 440: Spec 431 — Source Company Plugin: Grafana Labs
  GRAFANALABS = 'grafanalabs',
  // Phase 441: Spec 432 — Source Company Plugin: Cockroach Labs
  COCKROACHLABS = 'cockroachlabs',
  // Phase 442: Spec 433 — Source Company Plugin: Verkada
  VERKADA = 'verkada',
  // Phase 443: Spec 434 — Source Company Plugin: Nextdoor
  NEXTDOOR = 'nextdoor',
  // Phase 444: Spec 435 — Source Company Plugin: Mindbody
  MINDBODY = 'mindbody',
  // Phase 445: Spec 436 — Source Company Plugin: Omada Health
  OMADAHEALTH = 'omadahealth',
  // Phase 446: Spec 437 — Source Company Plugin: Sendbird
  SENDBIRD = 'sendbird',
  // Phase 447: Spec 438 — Source Company Plugin: ClickHouse
  CLICKHOUSE = 'clickhouse',
  // Phase 448: Spec 439 — Source Company Plugin: SingleStore
  SINGLESTORE = 'singlestore',
  // Phase 449: Spec 440 — Source Company Plugin: YugabyteDB
  YUGABYTE = 'yugabyte',
  // Phase 450: Spec 441 — Source Company Plugin: Wrike
  WRIKE = 'wrike',
  // Phase 451: Spec 442 — Source Company Plugin: UJET
  UJET = 'ujet',
  // Phase 452: Spec 443 — Source Company Plugin: Materialize
  MATERIALIZE = 'materialize',
  // Phase 453: Spec 444 — Source Company Plugin: Waymo
  WAYMO = 'waymo',
  // Phase 454: Spec 445 — Source Company Plugin: Remote
  REMOTECOM = 'remotecom',
  // Phase 455: Spec 446 — Source Company Plugin: Riot Games
  RIOTGAMES = 'riotgames',
  // Phase 456: Spec 447 — Source Company Plugin: Lucid Motors
  LUCIDMOTORS = 'lucidmotors',
  // Phase 457: Spec 448 — Source Company Plugin: Nuro
  NURO = 'nuro',
  // Phase 458: Spec 449 — Source Company Plugin: Together AI
  TOGETHERAI = 'togetherai',
  // Phase 459: Spec 450 — Source Company Plugin: Fireblocks
  FIREBLOCKS = 'fireblocks',
  // Phase 460: Spec 451 — Source Company Plugin: Tailscale
  TAILSCALE = 'tailscale',
  // Phase 461: Spec 452 — Source Company Plugin: project44
  PROJECT44 = 'project44',
  // Phase 462: Spec 453 — Source Company Plugin: Salesloft
  SALESLOFT = 'salesloft',
  // Phase 463: Spec 454 — Source Company Plugin: Builder.io
  BUILDER = 'builder',
  // Phase 464: Spec 455 — Source Company Plugin: Storyblok
  STORYBLOK = 'storyblok',
  // Phase 465: Spec 456 — Source Company Plugin: Imply
  IMPLY = 'imply',
  // Phase 466: Spec 457 — Source Company Plugin: Motive
  MOTIVE = 'motive',
  // Phase 467: Spec 458 — Source Company Plugin: Relativity Space
  RELATIVITY = 'relativity',
  // Phase 468: Spec 459 — Source Company Plugin: Navan
  TRIPACTIONS = 'tripactions',
  // Phase 469: Spec 460 — Source Company Plugin: Tenstorrent
  TENSTORRENT = 'tenstorrent',
  // Phase 470: Spec 461 — Source Company Plugin: DISCO
  DISCO = 'disco',
  // Phase 471: Spec 462 — Source Company Plugin: fal
  FAL = 'fal',
  // Phase 472: Spec 463 — Source Company Plugin: Epirus
  EPIRUS = 'epirus',
  // Phase 473: Spec 464 — Source Company Plugin: Everlaw
  EVERLAW = 'everlaw',
  // Phase 474: Spec 465 — Source Company Plugin: SurveyMonkey
  SURVEYMONKEY = 'surveymonkey',
  // Phase 475: Spec 466 — Source Company Plugin: Turing
  TURING = 'turing',
  // Phase 476: Spec 467 — Source Company Plugin: Huntress
  HUNTRESS = 'huntress',
  // Phase 477: Spec 468 — Source Company Plugin: Fireworks AI
  FIREWORKSAI = 'fireworksai',
  // Phase 478: Spec 469 — Source Company Plugin: HeyGen
  HEYGEN = 'heygen',
  // Phase 479: Spec 470 — Source Company Plugin: Runpod
  RUNPOD = 'runpod',
  // Phase 480: Spec 471 — Source Company Plugin: Merge
  MERGE = 'merge',
  // Phase 481: Spec 472 — Source Company Plugin: Alloy
  ALLOY = 'alloy',
  // Phase 482: Spec 473 — Source Company Plugin: Dashlane
  DASHLANE = 'dashlane',
  // Phase 483: Spec 474 — Source Company Plugin: Speechmatics
  SPEECHMATICS = 'speechmatics',
  // Phase 484: Spec 475 — Source Company Plugin: Highnote
  HIGHNOTE = 'highnote',
  // Phase 485: Spec 476 — Source Company Plugin: Lithic
  LITHIC = 'lithic',
  // Phase 486: Spec 477 — Source Company Plugin: FourKites
  FOURKITES = 'fourkites',
  // Phase 487: Spec 478 — Source Company Plugin: Comet
  COMET = 'comet',
  // Phase 488: Spec 479 — Source Company Plugin: Galileo
  GALILEO = 'galileo',
  // Phase 489: Spec 480 — Source Company Plugin: Inflection AI
  INFLECTIONAI = 'inflectionai',
  // Phase 490: Spec 481 — Source Company Plugin: Stability AI
  STABILITYAI = 'stabilityai',
  // Phase 491: Spec 482 — Source Company Plugin: Warp
  WARP = 'warp',
  // Phase 492: Spec 483 — Source Company Plugin: Current
  CURRENT = 'current',
  // Phase 493: Spec 484 — Source Company Plugin: Knock
  KNOCK = 'knock',
  // Phase 494: Spec 485 — Source Company Plugin: Mercari
  MERCARI = 'mercari',
  // Phase 495: Spec 486 — Source Company Plugin: Nubank
  NUBANK = 'nubank',
  // Phase 496: Spec 487 — Source Company Plugin: CookUnity
  COOKUNITY = 'cookunity',
  // Phase 497: Spec 488 — Source Company Plugin: Oklo
  OKLO = 'oklo',
  // Phase 498: Spec 489 — Source Company Plugin: Fetch
  FETCH = 'fetch',
  // Phase 499: Spec 490 — Source Company Plugin: Zocdoc
  ZOCDOC = 'zocdoc',
  // Phase 500: Spec 491 — Source Company Plugin: Thunes
  THUNES = 'thunes',
  // Phase 501: Spec 492 — Source Company Plugin: Strive Health
  STRIVEHEALTH = 'strivehealth',
  // Phase 502: Spec 493 — Source Company Plugin: Home Chef
  HOMECHEF = 'homechef',
  // Phase 503: Spec 494 — Source Company Plugin: Pacific Fusion
  PACIFICFUSION = 'pacificfusion',
  // Phase 504: Spec 495 — Source Company Plugin: Otter.ai
  OTTERAI = 'otterai',
  // Phase 505: Spec 496 — Source Company Plugin: Observe.AI
  OBSERVEAI = 'observeai',
  // Phase 506: Spec 497 — Source Company Plugin: Honor
  HONOR = 'honor',
  // Phase 507: Spec 498 — Source Company Plugin: Weee!
  WEEE = 'weee',
  // Phase 508: Spec 499 — Source Company Plugin: Narvar
  NARVAR = 'narvar',
  // Phase 509: Spec 500 — Source Company Plugin: Transcarent
  TRANSCARENT = 'transcarent',
  // Phase 510: Spec 501 — Source Company Plugin: Watershed Informatics
  WATERSHED = 'watershed',
  // Phase 511: Spec 502 — Source Company Plugin: Quaise Energy
  QUAISE = 'quaise',
  // Phase 512: Spec 503 — Source Company Plugin: Upside
  UPSIDE = 'upside',
  // Phase 513: Spec 504 — Source Company Plugin: Hungryroot
  HUNGRYROOT = 'hungryroot',
  // Phase 514: Spec 505 — Source Company Plugin: Nayya
  NAYYA = 'nayya',
  // Phase 515: Spec 506 — Source Company Plugin: Caribou Financial
  CARIBOU = 'caribou',
  // Phase 516: Spec 507 — Source Company Plugin: HealthJoy
  HEALTHJOY = 'healthjoy',
  // Phase 517: Spec 508 — Source Company Plugin: Papa
  PAPA = 'papa',
  // Phase 518: Spec 509 — Source Company Plugin: Upstart
  UPSTART = 'upstart',
  // Phase 519: Spec 510 — Source Company Plugin: Tamara
  TAMARA = 'tamara',
  // Phase 520: Spec 511 — Source Company Plugin: TrueLayer
  TRUELAYER = 'truelayer',
  // Phase 521: Spec 512 — Source Company Plugin: Public
  PUBLIC_INVEST = 'public',
  // Phase 522: Spec 513 — Source Company Plugin: Paystack
  PAYSTACK = 'paystack',
  // Phase 523: Spec 514 — Source Company Plugin: Moniepoint
  MONIEPOINT = 'moniepoint',
  // Phase 524: Spec 515 — Source Company Plugin: Thrive Market
  THRIVE_MARKET = 'thrivemarket',
  // Phase 525: Spec 516 — Source Company Plugin: Form3
  FORM3 = 'form3',
  // Phase 526: Spec 517 — Source Company Plugin: Marvel Fusion
  MARVEL_FUSION = 'marvelfusion',
  // Phase 527: Spec 518 — Source Company Plugin: Kairos Power
  KAIROS_POWER = 'kairospower',
  // Phase 528: Spec 519 — Source Company Plugin: Wolt
  WOLT = 'wolt',
  // Phase 529: Spec 520 — Source Company Plugin: Redwood Materials
  REDWOOD_MATERIALS = 'redwoodmaterials',
  // Phase 530: Spec 521 — Source Company Plugin: Group14 Technologies
  GROUP14 = 'group14',
  // Phase 531: Spec 522 — Source Company Plugin: Carbon
  CARBON = 'carbon',
  // Phase 532: Spec 523 — Source Company Plugin: Forward
  FORWARD_HEALTH = 'forward',
  // Phase 533: Spec 524 — Source Company Plugin: Tia
  TIA_HEALTH = 'tia',
  // Phase 534: Spec 525 — Source Company Plugin: Headway
  HEADWAY = 'headway',
  // Phase 535: Spec 526 — Source Company Plugin: Talkspace
  TALKSPACE = 'talkspace',
  // Phase 536: Spec 527 — Source Company Plugin: Octave
  OCTAVE_HEALTH = 'octave',
  // Phase 537: Spec 528 — Source Company Plugin: Freenome
  FREENOME = 'freenome',
  // Phase 538: Spec 529 — Source Company Plugin: Natera
  NATERA = 'natera',
  // Phase 539: Spec 530 — Source Company Plugin: Generate Biomedicines
  GENERATE_BIOMEDICINES = 'generatebiomedicines',
  // Phase 540: Spec 531 — Source Company Plugin: Oura
  OURA = 'oura',
  // Phase 541: Spec 532 — Source Company Plugin: Carvana
  CARVANA = 'carvana',
  // Phase 542: Spec 533 — Source Company Plugin: unybrands
  UNYBRANDS = 'unybrands',
  // Phase 543: Spec 534 — Source Company Plugin: Yotpo
  YOTPO = 'yotpo',
  // Phase 544: Spec 535 — Source Company Plugin: TaxBit
  TAXBIT = 'taxbit',
  // Phase 545: Spec 536 — Source Company Plugin: Culture Amp
  CULTURE_AMP = 'cultureamp',
  // Phase 546: Spec 537 — Source Company Plugin: Energage
  ENERGAGE = 'energage',
  // Phase 547: Spec 538 — Source Company Plugin: Veriff
  VERIFF = 'veriff',
  // Phase 548: Spec 539 — Source Company Plugin: Thoropass
  THOROPASS = 'thoropass',
  // Phase 549: Spec 540 — Source Company Plugin: Endor Labs
  ENDOR_LABS = 'endorlabs',
  // Phase 550: Spec 541 — Source Company Plugin: Cybereason
  CYBEREASON = 'cybereason',
  // Phase 551: Spec 542 — Source Company Plugin: Tanium
  TANIUM = 'tanium',
  // Phase 552: Spec 543 — Source Company Plugin: Expel
  EXPEL = 'expel',
  // Phase 553: Spec 544 — Source Company Plugin: Figure
  FIGURE = 'figureai',
  // Phase 554: Spec 545 — Source Company Plugin: Slice
  SLICE = 'slice',
  // Phase 555: Spec 546 — Source Company Plugin: Chowbus
  CHOWBUS = 'chowbus',
  // Phase 556: Spec 547 — Source Company Plugin: TabaPay
  TABAPAY = 'tabapay',
  // Phase 557: Spec 548 — Source Company Plugin: PathAI
  PATHAI = 'pathai',
  // Phase 558: Spec 549 — Source Company Plugin: Found
  FOUND = 'found',
  // Phase 559: Spec 550 — Source Company Plugin: Parsley Health
  PARSLEY_HEALTH = 'parsleyhealth',
  // Phase 560: Spec 551 — Source Company Plugin: Neuralink
  NEURALINK = 'neuralink',
  // Phase 561: Spec 552 — Source Company Plugin: CLEAR
  CLEAR = 'clear',
  // Phase 562: Spec 553 — Source Company Plugin: Apptronik
  APPTRONIK = 'apptronik',
  // Phase 563: Spec 554 — Source Company Plugin: Mill
  MILL = 'mill',
  // Phase 564: Spec 555 — Source Company Plugin: Clover Health
  CLOVER_HEALTH = 'cloverhealth',
  // Phase 565: Spec 556 — Source Company Plugin: OLIPOP
  OLIPOP = 'olipop',
  // Phase 566: Spec 557 — Source Company Plugin: Vannevar Labs
  VANNEVAR_LABS = 'vannevarlabs',
  // Phase 567: Spec 558 — Source Company Plugin: Diligent Robotics
  DILIGENT_ROBOTICS = 'diligentrobotics',
  // Phase 568: Spec 559 — Source Company Plugin: Wayve
  WAYVE = 'wayve',
  // Phase 569: Spec 560 — Source Company Plugin: Modern Animal
  MODERN_ANIMAL = 'modernanimal',
  // Phase 570: Spec 561 — Source Company Plugin: Bicycle Health
  BICYCLE_HEALTH = 'bicyclehealth',
  // Phase 571: Spec 562 — Source Company Plugin: Lunar Energy
  LUNAR_ENERGY = 'lunarenergy',
  // Phase 572: Spec 563 — Source Company Plugin: Electric Hydrogen
  ELECTRIC_HYDROGEN = 'eh2',
  // Phase 573: Spec 564 — Source Company Plugin: Tide
  TIDE = 'tide',
  // Phase 574: Spec 565 — Source Company Plugin: Imbue
  IMBUE = 'imbue',
  // Phase 575: Spec 566 — Source Company Plugin: One Medical
  ONE_MEDICAL = 'onemedical',
  // Phase 576: Spec 567 — Source Company Plugin: Relay Therapeutics
  RELAY_THERAPEUTICS = 'relaytherapeutics',
  // Phase 577: Spec 568 — Source Company Plugin: Formation Bio
  FORMATION_BIO = 'formationbio',
  // Phase 578: Spec 569 — Source Company Plugin: Valo Health
  VALO_HEALTH = 'valohealth',
  // Phase 579: Spec 570 — Source Company Plugin: Brooklinen
  BROOKLINEN = 'brooklinen',
  // Phase 580: Spec 571 — Source Company Plugin: Reformation
  REFORMATION = 'reformation',
  // Phase 581: Spec 572 — Source Company Plugin: Gymshark
  GYMSHARK = 'gymshark',
  // Phase 582: Spec 573 — Source Company Plugin: Rockstar Games
  ROCKSTAR_GAMES = 'rockstargames',
  // Phase 583: Spec 574 — Source Company Plugin: Outschool
  OUTSCHOOL = 'outschool',
  // Phase 584: Spec 575 — Source Company Plugin: Guild
  GUILD = 'guild',
  // Phase 585: Spec 576 — Source Company Plugin: Degreed
  DEGREED = 'degreed',
  // Phase 586: Spec 577 — Source Company Plugin: PhonePe
  PHONEPE = 'phonepe',
  // Phase 587: Spec 578 — Source Company Plugin: Groww
  GROWW = 'groww',
  // Phase 588: Spec 579 — Source Company Plugin: Ritual
  RITUAL = 'ritual',
  // Phase 589: Spec 580 — Source Company Plugin: Mejuri
  MEJURI = 'mejuri',
  // Phase 590: Spec 581 — Source Company Plugin: Parachute Home
  PARACHUTE_HOME = 'parachutehome',
  // Phase 591: Spec 582 — Source Company Plugin: Ginkgo Bioworks
  GINKGO_BIOWORKS = 'ginkgobioworks',
  // Phase 592: Spec 583 — Source Company Plugin: World Labs
  WORLD_LABS = 'worldlabs',
  // Phase 593: Spec 584 — Source Company Plugin: Recursion
  RECURSION = 'recursionpharmaceuticals',
  // Phase 594: Spec 585 — Source Company Plugin: Spire Global
  SPIRE_GLOBAL = 'spire',
  // Phase 595: Spec 586 — Source Company Plugin: Muon Space
  MUON_SPACE = 'muonspace',
  // Phase 596: Spec 587 — Source Company Plugin: FanDuel
  FANDUEL = 'fanduel',
  // Phase 597: Spec 588 — Source Company Plugin: Underdog
  UNDERDOG = 'underdogfantasy',
  // Phase 598: Spec 589 — Source Company Plugin: Future
  FUTURE_FITNESS = 'future',
  // Phase 599: Spec 590 — Source Company Plugin: Zwift
  ZWIFT = 'zwift',
  // Phase 600: Spec 591 — Source Company Plugin: Pacaso
  PACASO = 'pacaso',
  // Phase 601: Spec 592 — Source Company Plugin: Orchard
  ORCHARD = 'orchard',
  // Phase 602: Spec 593 — Source Company Plugin: Roofstock
  ROOFSTOCK = 'roofstock',
  // Phase 603: Spec 594 — Source Company Plugin: CarGurus
  CARGURUS = 'cargurus',
  // Phase 604: Spec 595 — Source Company Plugin: Ruggable
  RUGGABLE = 'ruggable',
  // Phase 605: Spec 596 — Source Company Plugin: Quince
  QUINCE = 'quince',
  // Phase 606: Spec 597 — Source Company Plugin: Everlane
  EVERLANE = 'everlane',
  // Phase 607: Spec 598 — Source Company Plugin: Zenni Optical
  ZENNI_OPTICAL = 'zennioptical',
  // Phase 608: Spec 599 — Source Company Plugin: goodr
  GOODR = 'goodr',
  // Phase 609: Spec 600 — Source Company Plugin: ThirdLove
  THIRDLOVE = 'thirdlove',
  // Phase 610: Spec 601 — Source Company Plugin: Cuyana
  CUYANA = 'cuyana',
  // Phase 611: Spec 602 — Source Company Plugin: Kikoff
  KIKOFF = 'kikoff',
  // Phase 612: Spec 603 — Source Company Plugin: DriveWealth
  DRIVEWEALTH = 'drivewealth',
  // Phase 613: Spec 604 — Source Company Plugin: Karat
  KARAT_INTERVIEWS = 'karat',
  // Phase 614: Spec 605 — Source Company Plugin: Suitsupply
  SUITSUPPLY = 'suitsupply',
  // Phase 615: Spec 606 — Source Company Plugin: Alo Yoga
  ALO_YOGA = 'aloyoga',
  // Phase 616: Spec 607 — Source Company Plugin: Kodiak Robotics
  KODIAK_ROBOTICS = 'kodiak',
  // Phase 617: Spec 608 — Source Company Plugin: Altruist
  ALTRUIST = 'altruist',
  // Phase 618: Spec 609 — Source Company Plugin: ON.energy
  ON_ENERGY = 'onenergy',
  // Phase 619: Spec 610 — Source Company Plugin: Divergent
  DIVERGENT = 'divergent',
  // Phase 620: Spec 611 — Source Company Plugin: Typeface
  TYPEFACE = 'typeface',
  // Phase 621: Spec 612 — Source Company Plugin: Range
  RANGE_TRAVEL = 'range',
  // Phase 622: Spec 613 — Source Company Plugin: Upgrade
  UPGRADE = 'upgrade',
  // Phase 623: Spec 614 — Source Company Plugin: Bombas
  BOMBAS = 'bombas',
  // Phase 624: Spec 615 — Source Company Plugin: Overstory
  OVERSTORY = 'overstory',
  // Phase 625: Spec 616 — Source Company Plugin: Stackline
  STACKLINE = 'stackline',
  // Phase 626: Spec 617 — Source Company Plugin: Pagaya
  PAGAYA = 'pagaya',
  // Phase 627: Spec 618 — Source Company Plugin: LetsGetChecked
  LETSGETCHECKED = 'letsgetchecked',
  // Phase 628: Spec 619 — Source Company Plugin: Happy Money
  HAPPY_MONEY = 'happymoney',
  // Phase 629: Spec 620 — Source Company Plugin: Clutch
  CLUTCH = 'clutch',
  // Phase 630: Spec 621 — Source Company Plugin: Counterpart
  COUNTERPART = 'counterpart',
  // Phase 631: Spec 622 — Source Company Plugin: EnergyHub
  ENERGYHUB = 'energyhub',
  // Phase 632: Spec 623 — Source Company Plugin: Ethos
  ETHOS = 'ethos',
  // Phase 633: Spec 624 — Source Company Plugin: Extend
  EXTEND = 'extend',
  // Phase 634: Spec 625 — Source Company Plugin: Ghost
  GHOST = 'ghost',
  // Phase 635: Spec 626 — Source Company Plugin: HomeLight
  HOMELIGHT = 'homelight',
  // Phase 636: Spec 627 — Source Company Plugin: Isomorphic Labs
  ISOMORPHIC_LABS = 'isomorphiclabs',
  // Phase 637: Spec 628 — Source Company Plugin: Loop
  LOOP = 'loop',
  // Phase 638: Spec 629 — Source Company Plugin: Openly
  OPENLY = 'openly',
  // Phase 639: Spec 630 — Source Company Plugin: Rocket Lab
  ROCKET_LAB = 'rocketlab',
  // Phase 640: Spec 631 — Source Company Plugin: Seurat Technologies
  SEURAT_TECHNOLOGIES = 'seurat',
  // Phase 641: Spec 632 — Source Company Plugin: SpaceX
  SPACEX = 'spacex',
  // Phase 642: Spec 633 — Source Company Plugin: Sparkfund
  SPARKFUND = 'sparkfund',
  // Phase 643: Spec 634 — Source Company Plugin: Rocket Money
  ROCKET_MONEY = 'truebill',
  // Phase 644: Spec 635 — Source Company Plugin: Weave
  WEAVE = 'weave',
  // Phase 645: Spec 636 — Source Company Plugin: Wing
  WING = 'wing',
  // Phase 646: Spec 637 — Source Company Plugin: Axiom
  AXIOM = 'axiom',
  // Phase 647: Spec 638 — Source Company Plugin: Bitso
  BITSO = 'bitso',
  // Phase 648: Spec 639 — Source Company Plugin: Ezra
  EZRA = 'ezra',
  // Phase 649: Spec 640 — Source Company Plugin: Fay
  FAY = 'fay',
  // Phase 650: Spec 641 — Source Company Plugin: Fingerprint
  FINGERPRINT = 'fingerprint',
  // Phase 651: Spec 642 — Source Company Plugin: Incode Technologies
  INCODE_TECHNOLOGIES = 'incode',
  // Phase 652: Spec 643 — Source Company Plugin: Jumio
  JUMIO = 'jumio',
  // Phase 653: Spec 644 — Source Company Plugin: Perpay
  PERPAY = 'perpay',
  // Phase 654: Spec 645 — Source Company Plugin: Prenuvo
  PRENUVO = 'prenuvo',
  // Phase 655: Spec 646 — Source Company Plugin: Vast
  VAST = 'vast',
  // Phase 656: Spec 647 — Source Company Plugin: C6 Bank
  C6_BANK = 'c6bank',
  // Phase 657: Spec 648 — Source Company Plugin: Carrot Fertility
  CARROT_FERTILITY = 'carrotfertility',
  // Phase 658: Spec 649 — Source Company Plugin: Clara
  CLARA = 'clara',
  // Phase 659: Spec 650 — Source Company Plugin: EBANX
  EBANX = 'ebanx',
  // Phase 660: Spec 651 — Source Company Plugin: Ethos Life
  ETHOS_LIFE = 'ethoslife',
  // Phase 661: Spec 652 — Source Company Plugin: Flo Health
  FLO_HEALTH = 'flohealth',
  // Phase 662: Spec 653 — Source Company Plugin: Harry's
  HARRY_S = 'harrys',
  // Phase 663: Spec 654 — Source Company Plugin: Insurify
  INSURIFY = 'insurify',
  // Phase 664: Spec 655 — Source Company Plugin: Ledgy
  LEDGY = 'ledgy',
  // Phase 665: Spec 656 — Source Company Plugin: Mission Lane
  MISSION_LANE = 'missionlane',
  // Phase 666: Spec 657 — Source Company Plugin: Mochi Health
  MOCHI_HEALTH = 'mochihealth',
  // Phase 667: Spec 658 — Source Company Plugin: Pie Insurance
  PIE_INSURANCE = 'pieinsurance',
  // Phase 668: Spec 659 — Source Company Plugin: QuintoAndar
  QUINTOANDAR = 'quintoandar',
  // Phase 669: Spec 660 — Source Company Plugin: quip
  QUIP = 'quip',
  // Phase 670: Spec 661 — Source Company Plugin: Rondo Energy
  RONDO_ENERGY = 'rondoenergy',
  // Phase 671: Spec 662 — Source Company Plugin: Silicon Ranch
  SILICON_RANCH = 'siliconranch',
  // Phase 672: Spec 663 — Source Company Plugin: On Running
  ON_RUNNING = 'onrunning',
  // Phase 673: Spec 664 — Source Company Plugin: Charlie Health
  CHARLIE_HEALTH = 'charliehealth',
  // Phase 674: Spec 665 — Source Company Plugin: Two Chairs
  TWO_CHAIRS = 'twochairs',
  // Phase 675: Spec 666 — Source Company Plugin: Nexamp
  NEXAMP = 'nexamp',
  // Phase 676: Spec 667 — Source Company Plugin: firsthand Health
  FIRSTHAND_HEALTH = 'firsthand',
  // Phase 677: Spec 668 — Source Company Plugin: Atoms Tech
  ATOMS_TECH = 'atoms',
  // Phase 678: Spec 669 — Source Company Plugin: Form Health
  FORM_HEALTH = 'formhealth',
  // Phase 679: Spec 670 — Source Company Plugin: Ilia Digital
  ILIA_DIGITAL = 'ilia',
  // Phase 680: Spec 671 — Source Company Plugin: Factorial Energy
  FACTORIAL_ENERGY = 'factorialenergy',
  // Phase 681: Spec 672 — Source Company Plugin: Sidecar Health
  SIDECAR_HEALTH = 'sidecarhealth',
  // Phase 682: Spec 673 — Source Company Plugin: Ownwell
  OWNWELL = 'ownwell',
  // Phase 683: Spec 674 — Source Company Plugin: Grove Collaborative
  GROVE_COLLABORATIVE = 'grovecollaborative',
  // Phase 684: Spec 675 — Source Company Plugin: Patch Caregiving
  PATCH_CAREGIVING = 'patch',
  // Phase 685: Spec 676 — Source Company Plugin: Nanit
  NANIT = 'nanit',
  // Phase 686: Spec 677 — Source Company Plugin: Nutrafol
  NUTRAFOL = 'nutrafol',
  // Phase 687: Spec 678 — Source Company Plugin: Waymark Health
  WAYMARK_HEALTH = 'waymark',
  // Phase 688: Spec 679 — Source Company Plugin: Seed Health
  SEED_HEALTH = 'seed',
  // Phase 689: Spec 680 — Source Company Plugin: Unite Us
  UNITE_US = 'uniteus',
  // Phase 690: Spec 681 — Source Company Plugin: Banyan Infrastructure
  BANYAN_INFRASTRUCTURE = 'banyaninfrastructure',
  // Phase 691: Spec 682 — Source Company Plugin: Camus Energy
  CAMUS_ENERGY = 'camusenergy',
  // Phase 692: Spec 683 — Source Company Plugin: Bitpanda
  BITPANDA = 'bitpanda',
  // Phase 693: Spec 684 — Source Company Plugin: BVNK
  BVNK = 'bvnk',
  // Phase 694: Spec 685 — Source Company Plugin: ChargePoint
  CHARGEPOINT = 'chargepoint',
  // Phase 695: Spec 686 — Source Company Plugin: Cleo AI
  CLEO_AI = 'cleo',
  // Phase 696: Spec 687 — Source Company Plugin: Inceptive
  INCEPTIVE = 'inceptive',
  // Phase 697: Spec 688 — Source Company Plugin: Momentous
  MOMENTOUS = 'momentous',
  // Phase 698: Spec 689 — Source Company Plugin: NewLimit
  NEWLIMIT = 'newlimit',
  // Phase 699: Spec 690 — Source Company Plugin: Ozow
  OZOW = 'ozow',
  // Phase 700: Spec 691 — Source Company Plugin: Profluent
  PROFLUENT = 'profluent',
  // Phase 701: Spec 692 — Source Company Plugin: Saatva
  SAATVA = 'saatva',
  // Phase 702: Spec 693 — Source Company Plugin: SumUp
  SUMUP = 'sumup',
  // Phase 703: Spec 694 — Source Company Plugin: Valence Labs
  VALENCE_LABS = 'valencelabs',
  // Phase 704: Spec 695 — Source Company Plugin: Verve Group
  VERVE_GROUP = 'verve',
  // Phase 705: Spec 696 — Source Company Plugin: Amperity
  AMPERITY = 'amperity',
  // Phase 706: Spec 697 — Source Company Plugin: Keeper Security
  KEEPER_SECURITY = 'keepersecurity',
  // Phase 707: Spec 698 — Source Company Plugin: mabl
  MABL = 'mabl',
  // Phase 708: Spec 699 — Source Company Plugin: Proton
  PROTON = 'proton',
  // Phase 709: Spec 700 — Source Company Plugin: StackBlitz
  STACKBLITZ = 'stackblitz',
  // Phase 710: Spec 701 — Source Company Plugin: Hometap
  HOMETAP = 'hometap',
  // Phase 711: Spec 702 — Source Company Plugin: Lightmatter
  LIGHTMATTER = 'lightmatter',
  // Phase 712: Spec 703 — Source Company Plugin: PsiQuantum
  PSIQUANTUM = 'psiquantum',
  // Phase 713: Spec 704 — Source Company Plugin: Quilt
  QUILT = 'quilt',
  // Phase 714: Spec 705 — Source Company Plugin: Riverlane
  RIVERLANE = 'riverlane',
  // Phase 715: Spec 706 — Source Company Plugin: Self Financial
  SELF_FINANCIAL = 'selffinancial',
  // Phase 716: Spec 707 — Source Company Plugin: Xendit
  XENDIT = 'xendit',
  // Phase 717: Spec 708 — Source Company Plugin: BetterHelp
  BETTERHELP = 'betterhelp',
  // Phase 718: Spec 709 — Source Company Plugin: Bybit
  BYBIT = 'bybit',
  // Phase 719: Spec 710 — Source Company Plugin: FalconX
  FALCONX = 'falconx',
  // Phase 720: Spec 711 — Source Company Plugin: OKX
  OKX = 'okx',
  // Phase 721: Spec 712 — Source Company Plugin: Prove
  PROVE = 'prove',
  // Phase 722: Spec 713 — Source Company Plugin: Securitize
  SECURITIZE = 'securitize',
  // Phase 723: Spec 714 — Source Company Plugin: Solid Power
  SOLID_POWER = 'solidpower',
  // Phase 724: Spec 715 — Source Company Plugin: CoreWeave
  COREWEAVE = 'coreweave',
  // Phase 725: Spec 716 — Source Company Plugin: Nebius
  NEBIUS = 'nebius',
  // Phase 726: Spec 717 — Source Company Plugin: Udio
  UDIO = 'udio',
  // Phase 727: Spec 718 — Source Job Board Plugin: Solid.Jobs (solid.jobs)
  SOLIDJOBS = 'solidjobs',
  // Phase 728: Spec 723 — Source Company Plugin: Agility Robotics
  AGILITY_ROBOTICS = 'agilityrobotics',
  // Phase 729: Spec 724 — Source Company Plugin: Arc Institute
  ARC_INSTITUTE = 'arcinstitute',
  // Phase 730: Spec 725 — Source Company Plugin: Mesh Payments
  MESH_PAYMENTS = 'mesh',
  // Phase 731: Spec 726 — Source Company Plugin: Xaira Therapeutics
  XAIRA_THERAPEUTICS = 'xairatherapeutics',
  // Phase 732: Spec 727 — Source Company Plugin: Zola
  ZOLA = 'zola',
  // Phase 733: Spec 728 — Source Company Plugin: Cerebras Systems
  CEREBRAS_SYSTEMS = 'cerebrassystems',
  // Phase 734: Spec 729 — Source Company Plugin: Parloa
  PARLOA = 'parloa',
  // Phase 735: Spec 730 — Source Company Plugin: QphoX
  QPHOX = 'qphox',
  // Phase 736: Spec 731 — Source Company Plugin: Zencoder
  ZENCODER = 'zencoder',
  // Phase 737: Spec 741 — Source ATS Plugin: Beisen (北森 / iTalent, zhiye.com)
  BEISEN = 'beisen',
  // Phase 738: Spec 742 — Source Company Plugin: Butterfly Network
  BUTTERFLY_NETWORK = 'butterflynetwork',
  // Phase 739: Spec 743 — Source Company Plugin: Figure Lending
  FIGURE_LENDING = 'figure',
  // Phase 740: Spec 744 — Source Company Plugin: GoGuardian
  GOGUARDIAN = 'goguardian',
  // Phase 741: Spec 745 — Source Company Plugin: HighRadius
  HIGHRADIUS = 'highradius',
  // Phase 742: Spec 746 — Source Company Plugin: Khan Academy
  KHAN_ACADEMY = 'khanacademy',
  // Phase 743: Spec 747 — Source Company Plugin: Locus Robotics
  LOCUS_ROBOTICS = 'locusrobotics',
  // Phase 744: Spec 748 — Source Company Plugin: Motional
  MOTIONAL = 'motional',
  // Phase 745: Spec 749 — Source Company Plugin: Nauto
  NAUTO = 'nauto',
  // Phase 746: Spec 750 — Source Company Plugin: Netradyne
  NETRADYNE = 'netradyne',
  // Phase 747: Spec 751 — Source Company Plugin: Newsela
  NEWSELA = 'newsela',
  // Phase 748: Spec 752 — Source Company Plugin: OfferUp
  OFFERUP = 'offerup',
  // Phase 749: Spec 753 — Source Company Plugin: Ophelos
  OPHELOS = 'ophelos',
  // Phase 750: Spec 754 — Source Company Plugin: Oportun
  OPORTUN = 'oportun',
  // Phase 751: Spec 755 — Source Company Plugin: Udacity
  UDACITY = 'udacity',
  // Phase 752: Spec 756 — Source Company Plugin: Absci
  ABSCI = 'absci',
  // Phase 753: Spec 757 — Source Company Plugin: Astranis
  ASTRANIS = 'astranis',
  // Phase 754: Spec 758 — Source Company Plugin: AST SpaceMobile
  AST_SPACEMOBILE = 'astspacemobile',
  // Phase 755: Spec 759 — Source Company Plugin: BlackSky Technology
  BLACKSKY_TECHNOLOGY = 'blacksky',
  // Phase 756: Spec 760 — Source Company Plugin: Elation Health
  ELATION_HEALTH = 'elationhealth',
  // Phase 757: Spec 761 — Source Company Plugin: Flatiron Health
  FLATIRON_HEALTH = 'flatironhealth',
  // Phase 758: Spec 762 — Source Company Plugin: Form Bio
  FORM_BIO = 'formbio',
  // Phase 759: Spec 763 — Source Company Plugin: HawkEye 360
  HAWKEYE_360 = 'hawkeye360',
  // Phase 760: Spec 764 — Source Company Plugin: Hubble Network
  HUBBLE_NETWORK = 'hubblenetwork',
  // Phase 761: Spec 765 — Source Company Plugin: Komodo Health
  KOMODO_HEALTH = 'komodohealth',
  // Phase 762: Spec 766 — Source Company Plugin: Ophelia Health
  OPHELIA_HEALTH = 'ophelia',
  // Phase 763: Spec 767 — Source Company Plugin: Peak Energy
  PEAK_ENERGY = 'peakenergy',
  // Phase 764: Spec 768 — Source Company Plugin: Qventus
  QVENTUS = 'qventus',
  // Phase 765: Spec 769 — Source Company Plugin: Sila Nanotechnologies
  SILA_NANOTECHNOLOGIES = 'silananotechnologies',
  // Phase 766: Spec 770 — Source Company Plugin: Suki AI
  SUKI_AI = 'suki',
  // Phase 767: Spec 771 — Source Company Plugin: Twist Bioscience
  TWIST_BIOSCIENCE = 'twistbioscience',
  // Phase 769: Spec 773 — Source Company Plugin: CHAOS Industries
  CHAOS_INDUSTRIES = 'chaosindustries',
  // Phase 771: Spec 775 — Source Company Plugin: Cortica
  CORTICA = 'cortica',
  // Phase 775: Spec 779 — Source Company Plugin: Formic
  FORMIC = 'formic',
  // Phase 777: Spec 781 — Source Company Plugin: Helsing
  HELSING = 'helsing',
  // Phase 768: Spec 772 — Source Company Plugin: Carbon Robotics
  CARBON_ROBOTICS = 'carbonrobotics',
  // Phase 770: Spec 774 — Source Company Plugin: Cohere Health
  COHERE_HEALTH = 'coherehealth',
  // Phase 772: Spec 776 — Source Company Plugin: Dyno Therapeutics
  DYNO_THERAPEUTICS = 'dynotherapeutics',
  // Phase 773: Spec 777 — Source Company Plugin: Eikon Therapeutics
  EIKON_THERAPEUTICS = 'eikontherapeutics',
  // Phase 774: Spec 778 — Source Company Plugin: Etched
  ETCHED = 'etchedai',
  // Phase 776: Spec 780 — Source Company Plugin: Garner Health
  GARNER_HEALTH = 'garnerhealth',
  // Phase 778: Spec 782 — Source Company Plugin: Path Robotics
  PATH_ROBOTICS = 'pathrobotics',
  // Phase 779: Spec 783 — Source Company Plugin: Pivot Bio
  PIVOT_BIO = 'pivotbio',
  // Phase 780: Spec 784 — Source Company Plugin: SambaNova Systems
  SAMBANOVA_SYSTEMS = 'sambanovasystems',
  // Phase 781: Spec 785 — Source Company Plugin: Slingshot Aerospace
  SLINGSHOT_AEROSPACE = 'slingshotaerospace',
  // Phase 782: Spec 786 — Source Company Plugin: Sound Agriculture
  SOUND_AGRICULTURE = 'soundagriculture',
}

/**
 * Map a raw string (case-insensitive) to a Site enum value.
 */
export function mapStringToSite(siteName: string): Site {
  const key = siteName.toUpperCase() as keyof typeof Site;
  if (Site[key] !== undefined) {
    return Site[key];
  }
  // Fallback for custom plugins/scrapers
  return siteName.toLowerCase() as Site;
}
