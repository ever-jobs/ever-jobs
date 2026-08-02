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
  // Phase 783: Spec 788 — Source Company Plugin: AIR COMPANY
  AIR_COMPANY = 'aircompany',
  // Phase 784: Spec 789 — Source Company Plugin: Arbor Energy
  ARBOR_ENERGY = 'arborenergy',
  // Phase 785: Spec 790 — Source Company Plugin: Aurora Innovation
  AURORA_INNOVATION = 'aurorainnovation',
  // Phase 786: Spec 791 — Source Company Plugin: EarnIn
  EARNIN = 'earnin',
  // Phase 787: Spec 792 — Source Company Plugin: Faraday Future
  FARADAY_FUTURE = 'faradayfuture',
  // Phase 788: Spec 793 — Source Company Plugin: FastSpring
  FASTSPRING = 'fastspring',
  // Phase 789: Spec 794 — Source Company Plugin: Gravity R&D
  GRAVITY_R_D = 'gravity',
  // Phase 790: Spec 795 — Source Company Plugin: Runwise
  RUNWISE = 'runwise',
  // Phase 791: Spec 796 — Source Company Plugin: SES AI
  SES_AI = 'sesai',
  // Phase 792: Spec 797 — Source Company Plugin: Solaris
  SOLARIS = 'solarisbank',
  // Phase 793: Spec 798 — Source Company Plugin: Stack AV
  STACK_AV = 'stackav',
  // Phase 794: Spec 799 — Source Company Plugin: tastytrade
  TASTYTRADE = 'tastytrade',
  // Phase 795: Spec 800 — Source Company Plugin: Torc Robotics
  TORC_ROBOTICS = 'torcrobotics',
  // Phase 796: Spec 801 — Source Company Plugin: Ursa Major
  URSA_MAJOR = 'ursamajor',
  // Phase 797: Spec 802 — Source Company Plugin: Via
  VIA = 'via',
  // Phase 798: Spec 803 — Source Company Plugin: Zuora
  ZUORA = 'zuora',
  // Phase 799: Spec 804 — Source Company Plugin: Accela
  ACCELA = 'accela',
  // Phase 800: Spec 805 — Source Company Plugin: AEVEX Aerospace
  AEVEX_AEROSPACE = 'aevexaerospace',
  // Phase 801: Spec 806 — Source Company Plugin: Akaysha Energy
  AKAYSHA_ENERGY = 'akayshaenergy',
  // Phase 802: Spec 807 — Source Company Plugin: Anduril Industries
  ANDURIL_INDUSTRIES = 'andurilindustries',
  // Phase 803: Spec 808 — Source Company Plugin: Armis
  ARMIS = 'armissecurity',
  // Phase 804: Spec 809 — Source Company Plugin: At-Bay
  AT_BAY = 'atbayjobs',
  // Phase 805: Spec 810 — Source Company Plugin: Atomic Machines
  ATOMIC_MACHINES = 'atomicmachines',
  // Phase 806: Spec 811 — Source Company Plugin: Augury
  AUGURY = 'augury',
  // Phase 807: Spec 812 — Source Company Plugin: Aura
  AURA = 'aura',
  // Phase 808: Spec 813 — Source Company Plugin: Avantus
  AVANTUS = 'avantus',
  // Phase 809: Spec 814 — Source Company Plugin: Avride
  AVRIDE = 'avride',
  // Phase 810: Spec 815 — Source Company Plugin: Axonius
  AXONIUS = 'axonius',
  // Phase 811: Spec 816 — Source Company Plugin: Beam Therapeutics
  BEAM_THERAPEUTICS = 'beamtherapeutics',
  // Phase 812: Spec 817 — Source Company Plugin: Blockchain.com
  BLOCKCHAIN_COM = 'blockchain',
  // Phase 813: Spec 818 — Source Company Plugin: Bot Auto
  BOT_AUTO = 'botauto',
  // Phase 814: Spec 819 — Source Company Plugin: BuildOps
  BUILDOPS = 'buildops',
  // Phase 815: Spec 820 — Source Company Plugin: C3 AI
  C3_AI = 'c3iot',
  // Phase 816: Spec 821 — Source Company Plugin: Cabify
  CABIFY = 'cabify',
  // Phase 817: Spec 822 — Source Company Plugin: Cargomatic
  CARGOMATIC = 'cargomatic',
  // Phase 818: Spec 823 — Source Company Plugin: Censys
  CENSYS = 'censys',
  // Phase 819: Spec 824 — Source Company Plugin: CharterUP
  CHARTERUP = 'charterup',
  // Phase 820: Spec 825 — Source Company Plugin: Checkbook
  CHECKBOOK = 'checkbook',
  // Phase 821: Spec 826 — Source Company Plugin: CodePath
  CODEPATH = 'codepath',
  // Phase 822: Spec 827 — Source Company Plugin: Cognitiv
  COGNITIV = 'cognitiv',
  // Phase 823: Spec 828 — Source Company Plugin: Collibra
  COLLIBRA = 'collibra',
  // Phase 824: Spec 829 — Source Company Plugin: Colossal Biosciences
  COLOSSAL_BIOSCIENCES = 'colossalbiosciences',
  // Phase 825: Spec 830 — Source Company Plugin: Customer.io
  CUSTOMER_IO = 'customerio',
  // Phase 826: Spec 831 — Source Company Plugin: Cypress Creek Renewables
  CYPRESS_CREEK_RENEWABLES = 'cypresscreekrenewables',
  // Phase 827: Spec 832 — Source Company Plugin: Daybreak Game Company
  DAYBREAK_GAME_COMPANY = 'daybreakgames',
  // Phase 828: Spec 833 — Source Company Plugin: dbt Labs
  DBT_LABS = 'dbtlabsinc',
  // Phase 829: Spec 834 — Source Company Plugin: Dealpath
  DEALPATH = 'dealpath',
  // Phase 830: Spec 835 — Source Company Plugin: Defense Unicorns
  DEFENSE_UNICORNS = 'defenseunicorns',
  // Phase 831: Spec 836 — Source Company Plugin: Digital Extremes
  DIGITAL_EXTREMES = 'digitalextremes',
  // Phase 832: Spec 837 — Source Company Plugin: Dorsia
  DORSIA = 'dorsia',
  // Phase 833: Spec 838 — Source Company Plugin: Easyship
  EASYSHIP = 'easyship',
  // Phase 834: Spec 839 — Source Company Plugin: Eleventh Hour Games
  ELEVENTH_HOUR_GAMES = 'eleventhhourgames',
  // Phase 835: Spec 840 — Source Company Plugin: EMARKETER
  EMARKETER = 'emarketer',
  // Phase 836: Spec 841 — Source Company Plugin: emnify
  EMNIFY = 'emnify',
  // Phase 837: Spec 842 — Source Company Plugin: Energy Solutions
  ENERGY_SOLUTIONS = 'energysolutions',
  // Phase 838: Spec 843 — Source Company Plugin: Esusu
  ESUSU = 'esusu',
  // Phase 839: Spec 844 — Source Company Plugin: Exiger
  EXIGER = 'exiger',
  // Phase 840: Spec 845 — Source Company Plugin: ExtraHop
  EXTRAHOP = 'extrahopnetworks',
  // Phase 841: Spec 846 — Source Company Plugin: Federato
  FEDERATO = 'federato',
  // Phase 842: Spec 847 — Source Company Plugin: Feedzai
  FEEDZAI = 'feedzai',
  // Phase 843: Spec 848 — Source Company Plugin: Fieldwire
  FIELDWIRE = 'fieldwire',
  // Phase 844: Spec 849 — Source Company Plugin: Flashfood
  FLASHFOOD = 'flashfood',
  // Phase 845: Spec 850 — Source Company Plugin: Fleetio
  FLEETIO = 'fleetio',
  // Phase 846: Spec 851 — Source Company Plugin: Forbes
  FORBES = 'forbes',
  // Phase 847: Spec 852 — Source Company Plugin: Forter
  FORTER = 'forter',
  // Phase 848: Spec 853 — Source Company Plugin: Freeform
  FREEFORM = 'freeformfuturecorp',
  // Phase 849: Spec 854 — Source Company Plugin: Galvanize Climate Solutions
  GALVANIZE_CLIMATE_SOLUTIONS = 'galvanizeclimatesolutions',
  // Phase 850: Spec 855 — Source Company Plugin: Gatik AI
  GATIK_AI = 'gatikaiinc',
  // Phase 851: Spec 856 — Source Company Plugin: Glean
  GLEAN = 'gleanwork',
  // Phase 852: Spec 857 — Source Company Plugin: GlossGenius
  GLOSSGENIUS = 'glossgenius',
  // Phase 853: Spec 858 — Source Company Plugin: Goodway Group
  GOODWAY_GROUP = 'goodwaygroup',
  // Phase 854: Spec 859 — Source Company Plugin: Gotion
  GOTION = 'gotion',
  // Phase 855: Spec 860 — Source Company Plugin: GovTech Singapore (Government Technology Agency)
  GOVTECH_SINGAPORE_GOVERNMENT_TECHNOLOGY_AGENCY = 'govtech',
  // Phase 856: Spec 861 — Source Company Plugin: Ghost Story Games
  GHOST_STORY_GAMES = 'gsgcareers',
  // Phase 857: Spec 862 — Source Company Plugin: Hanwha Renewables
  HANWHA_RENEWABLES = 'hanwharenewables',
  // Phase 858: Spec 863 — Source Company Plugin: Herald
  HERALD = 'heraldapi',
  // Phase 859: Spec 864 — Source Company Plugin: Homeward
  HOMEWARD = 'homeward',
  // Phase 860: Spec 865 — Source Company Plugin: Hyliion
  HYLIION = 'hyliion',
  // Phase 861: Spec 866 — Source Company Plugin: Hyperproof
  HYPERPROOF = 'hyperproof',
  // Phase 862: Spec 867 — Source Company Plugin: ID.me
  ID_ME = 'idme',
  // Phase 863: Spec 868 — Source Company Plugin: InCharge Energy
  INCHARGE_ENERGY = 'inchargeenergy',
  // Phase 864: Spec 869 — Source Company Plugin: Innovid
  INNOVID = 'innovid',
  // Phase 865: Spec 870 — Source Company Plugin: Instawork
  INSTAWORK = 'instawork',
  // Phase 866: Spec 871 — Source Company Plugin: Intrinsic
  INTRINSIC = 'intrinsicrobotics',
  // Phase 867: Spec 872 — Source Company Plugin: Integrated Specialty Coverages
  INTEGRATED_SPECIALTY_COVERAGES = 'isccareers',
  // Phase 868: Spec 873 — Source Company Plugin: ITS Logistics
  ITS_LOGISTICS = 'itslogisticsllc',
  // Phase 869: Spec 874 — Source Company Plugin: K2 Space
  K2_SPACE = 'k2spacecorporation',
  // Phase 870: Spec 875 — Source Company Plugin: Kasa
  KASA = 'kasa',
  // Phase 871: Spec 876 — Source Company Plugin: KH Aerospace
  KH_AEROSPACE = 'khaerospace',
  // Phase 872: Spec 877 — Source Company Plugin: KnowBe4
  KNOWBE4 = 'knowbe4',
  // Phase 873: Spec 878 — Source Company Plugin: Legion Technologies
  LEGION_TECHNOLOGIES = 'legion',
  // Phase 874: Spec 879 — Source Company Plugin: LogicGate
  LOGICGATE = 'logicgate',
  // Phase 875: Spec 880 — Source Company Plugin: Mark43
  MARK43 = 'mark43',
  // Phase 876: Spec 881 — Source Company Plugin: Matic Insurance
  MATIC_INSURANCE = 'matic',
  // Phase 877: Spec 882 — Source Company Plugin: May Mobility
  MAY_MOBILITY = 'maymobility',
  // Phase 878: Spec 883 — Source Company Plugin: mediasmart
  MEDIASMART = 'mediasmart',
  // Phase 879: Spec 884 — Source Company Plugin: Metropolis Technologies
  METROPOLIS_TECHNOLOGIES = 'metropolis',
  // Phase 880: Spec 885 — Source Company Plugin: MobilityWare
  MOBILITYWARE = 'mobilityware',
  // Phase 881: Spec 886 — Source Company Plugin: Modernize Home Services
  MODERNIZE_HOME_SERVICES = 'modernize',
  // Phase 882: Spec 887 — Source Company Plugin: MrBeast (Beast Industries)
  MRBEAST_BEAST_INDUSTRIES = 'mrbeastyoutube',
  // Phase 883: Spec 888 — Source Company Plugin: Nabis
  NABIS = 'nabis',
  // Phase 884: Spec 889 — Source Company Plugin: NPR (National Public Radio)
  NPR_NATIONAL_PUBLIC_RADIO = 'nationalpublicradioinc',
  // Phase 885: Spec 890 — Source Company Plugin: Neon Aerospace
  NEON_AEROSPACE = 'neonaerospace',
  // Phase 886: Spec 891 — Source Company Plugin: Neros Technologies
  NEROS_TECHNOLOGIES = 'nerostechnologies',
  // Phase 887: Spec 892 — Source Company Plugin: New Leaf Energy
  NEW_LEAF_ENERGY = 'newleafenergy',
  // Phase 888: Spec 893 — Source Company Plugin: Nex
  NEX = 'nex',
  // Phase 889: Spec 894 — Source Company Plugin: Next Insurance
  NEXT_INSURANCE = 'nextinsurance66',
  // Phase 890: Spec 895 — Source Company Plugin: Nimble Robotics
  NIMBLE_ROBOTICS = 'nimblerobotics',
  // Phase 891: Spec 896 — Source Company Plugin: NMI
  NMI = 'nmi',
  // Phase 892: Spec 897 — Source Company Plugin: Northspyre
  NORTHSPYRE = 'northspyre',
  // Phase 893: Spec 898 — Source Company Plugin: Nothing
  NOTHING = 'nothing',
  // Phase 894: Spec 899 — Source Company Plugin: OneTrust
  ONETRUST = 'onetrust',
  // Phase 895: Spec 900 — Source Company Plugin: OpenSpace
  OPENSPACE = 'openspace',
  // Phase 896: Spec 901 — Source Company Plugin: OpenTable
  OPENTABLE = 'opentable',
  // Phase 897: Spec 902 — Source Company Plugin: Veo
  VEO = 'operationscareers',
  // Phase 898: Spec 903 — Source Company Plugin: Orca Security
  ORCA_SECURITY = 'orcasecurity',
  // Phase 899: Spec 904 — Source Company Plugin: Origis Energy
  ORIGIS_ENERGY = 'origisenergy',
  // Phase 900: Spec 905 — Source Company Plugin: Osano
  OSANO = 'osano',
  // Phase 901: Spec 906 — Source Company Plugin: Pacvue
  PACVUE = 'pacvue',
  // Phase 902: Spec 907 — Source Company Plugin: Palmetto Clean Technology
  PALMETTO_CLEAN_TECHNOLOGY = 'palmettocleantech',
  // Phase 903: Spec 908 — Source Company Plugin: Pathward
  PATHWARD = 'pathward',
  // Phase 904: Spec 909 — Source Company Plugin: PayNearMe
  PAYNEARME = 'paynearmeinc',
  // Phase 905: Spec 910 — Source Company Plugin: Payoneer
  PAYONEER = 'payoneer',
  // Phase 906: Spec 911 — Source Company Plugin: Pixability
  PIXABILITY = 'pixability',
  // Phase 907: Spec 912 — Source Company Plugin: Plus Power
  PLUS_POWER = 'pluspower',
  // Phase 908: Spec 913 — Source Company Plugin: The Pokémon Company International
  THE_POK_MON_COMPANY_INTERNATIONAL = 'pokemoncareers',
  // Phase 909: Spec 914 — Source Company Plugin: Prime Medicine
  PRIME_MEDICINE = 'primemedicine',
  // Phase 910: Spec 915 — Source Company Plugin: PubMatic
  PUBMATIC = 'pubmatic',
  // Phase 911: Spec 916 — Source Company Plugin: Qualia
  QUALIA = 'qualia',
  // Phase 912: Spec 917 — Source Company Plugin: Razorpay
  RAZORPAY = 'razorpaysoftwareprivatelimited',
  // Phase 913: Spec 918 — Source Company Plugin: Recorded Future
  RECORDED_FUTURE = 'recordedfuture',
  // Phase 914: Spec 919 — Source Company Plugin: Renaissance Learning
  RENAISSANCE_LEARNING = 'renaissancelearning-nam',
  // Phase 915: Spec 920 — Source Company Plugin: Riskified
  RISKIFIED = 'riskified',
  // Phase 916: Spec 921 — Source Company Plugin: Rithum
  RITHUM = 'rithum',
  // Phase 917: Spec 922 — Source Company Plugin: Rocket Lawyer
  ROCKET_LAWYER = 'rocketlawyer',
  // Phase 918: Spec 923 — Source Company Plugin: Roku
  ROKU = 'roku',
  // Phase 919: Spec 924 — Source Company Plugin: Sana Biotechnology
  SANA_BIOTECHNOLOGY = 'sanabiotech',
  // Phase 920: Spec 925 — Source Company Plugin: Sayari
  SAYARI = 'sayari',
  // Phase 921: Spec 926 — Source Company Plugin: Scout AI
  SCOUT_AI = 'scoutai',
  // Phase 922: Spec 927 — Source Company Plugin: SecurityScorecard
  SECURITYSCORECARD = 'securityscorecard',
  // Phase 923: Spec 928 — Source Company Plugin: SeekOut
  SEEKOUT = 'seekout',
  // Phase 924: Spec 929 — Source Company Plugin: Seoul Robotics
  SEOUL_ROBOTICS = 'seoulrobotics',
  // Phase 925: Spec 930 — Source Company Plugin: Shift Technology
  SHIFT_TECHNOLOGY = 'shifttechnology',
  // Phase 926: Spec 931 — Source Company Plugin: ShipBob
  SHIPBOB = 'shipbobinc',
  // Phase 927: Spec 932 — Source Company Plugin: ShipMonk
  SHIPMONK = 'shipmonk',
  // Phase 928: Spec 933 — Source Company Plugin: Skillsoft
  SKILLSOFT = 'skillsoft',
  // Phase 929: Spec 934 — Source Company Plugin: SmartRent
  SMARTRENT = 'smartrent',
  // Phase 930: Spec 935 — Source Company Plugin: Snorkel AI
  SNORKEL_AI = 'snorkelai',
  // Phase 931: Spec 936 — Source Company Plugin: Sol de Janeiro
  SOL_DE_JANEIRO = 'soldejaneiro',
  // Phase 932: Spec 937 — Source Company Plugin: PlayStation (Sony Interactive Entertainment)
  PLAYSTATION_SONY_INTERACTIVE_ENTERTAINMENT = 'sonyinteractiveentertainmentglobal',
  // Phase 933: Spec 938 — Source Company Plugin: Speechify
  SPEECHIFY = 'speechify',
  // Phase 934: Spec 939 — Source Company Plugin: Spin
  SPIN = 'spin',
  // Phase 935: Spec 940 — Source Company Plugin: Splice
  SPLICE = 'splice',
  // Phase 936: Spec 941 — Source Company Plugin: SpotHopper
  SPOTHOPPER = 'spothopper',
  // Phase 937: Spec 942 — Source Company Plugin: StackAdapt
  STACKADAPT = 'stackadapt',
  // Phase 938: Spec 943 — Source Company Plugin: Starface World
  STARFACE_WORLD = 'starfaceworld',
  // Phase 939: Spec 944 — Source Company Plugin: Stoke Space
  STOKE_SPACE = 'stokespacetechnologies',
  // Phase 940: Spec 945 — Source Company Plugin: Strand Therapeutics
  STRAND_THERAPEUTICS = 'strandtherapeutics',
  // Phase 941: Spec 946 — Source Company Plugin: Sumo Logic
  SUMO_LOGIC = 'sumologic',
  // Phase 942: Spec 947 — Source Company Plugin: Take-Two Interactive
  TAKE_TWO_INTERACTIVE = 'taketwo',
  // Phase 943: Spec 948 — Source Company Plugin: Tebra
  TEBRA = 'tebra',
  // Phase 944: Spec 949 — Source Company Plugin: TEGNA
  TEGNA = 'tegnainc',
  // Phase 945: Spec 950 — Source Company Plugin: Tenable
  TENABLE = 'tenableinc',
  // Phase 946: Spec 951 — Source Company Plugin: Terran Orbital
  TERRAN_ORBITAL = 'terranorbitalcorporation',
  // Phase 947: Spec 952 — Source Company Plugin: Tessera Therapeutics
  TESSERA_THERAPEUTICS = 'tesseratherapeutics',
  // Phase 948: Spec 953 — Source Company Plugin: Dutchie
  DUTCHIE = 'thedutchie',
  // Phase 949: Spec 954 — Source Company Plugin: The New York Times
  THE_NEW_YORK_TIMES = 'thenewyorktimes',
  // Phase 950: Spec 955 — Source Company Plugin: The Trade Desk
  THE_TRADE_DESK = 'thetradedesk',
  // Phase 951: Spec 956 — Source Company Plugin: Third Wave Automation
  THIRD_WAVE_AUTOMATION = 'thirdwaveautomation',
  // Phase 952: Spec 957 — Source Company Plugin: Too Good To Go
  TOO_GOOD_TO_GO = 'toogoodtogo',
  // Phase 953: Spec 958 — Source Company Plugin: Toradex
  TORADEX = 'toradex',
  // Phase 954: Spec 959 — Source Company Plugin: Transmit Security
  TRANSMIT_SECURITY = 'transmitsecurity',
  // Phase 955: Spec 960 — Source Company Plugin: True Anomaly
  TRUE_ANOMALY = 'trueanomalyinc',
  // Phase 956: Spec 961 — Source Company Plugin: Picnic Delivery
  PICNIC_DELIVERY = 'try-picnic',
  // Phase 957: Spec 962 — Source Company Plugin: Uber Freight
  UBER_FREIGHT = 'uberfreight',
  // Phase 958: Spec 963 — Source Company Plugin: Unqork
  UNQORK = 'unqork',
  // Phase 959: Spec 964 — Source Company Plugin: Varda Space Industries
  VARDA_SPACE_INDUSTRIES = 'vardaspace',
  // Phase 960: Spec 965 — Source Company Plugin: Verra Mobility
  VERRA_MOBILITY = 'verramobility',
  // Phase 961: Spec 966 — Source Company Plugin: Viant Technology
  VIANT_TECHNOLOGY = 'vianttechnology',
  // Phase 962: Spec 967 — Source Company Plugin: Viral Nation
  VIRAL_NATION = 'viralnation',
  // Phase 963: Spec 968 — Source Company Plugin: Vox Media
  VOX_MEDIA = 'voxmedia',
  // Phase 964: Spec 969 — Source Company Plugin: VTS
  VTS = 'vts',
  // Phase 965: Spec 970 — Source Company Plugin: Wildlife Studios
  WILDLIFE_STUDIOS = 'wildlifestudios',
  // Phase 966: Spec 971 — Source Company Plugin: Wiz
  WIZ = 'wizinc',
  // Phase 967: Spec 972 — Source Company Plugin: Wurl
  WURL = 'wurljobs',
  // Phase 969: Spec 974 — Source Company Plugin: Zynga
  ZYNGA = 'zyngacareers',
  // Phase 970: Spec 5036 — AppOne (Paychex-owned) ATS plugin
  APPONE = 'appone',
  // Phase 971: Spec 5041 — PrismHR (HiringThing) ATS plugin
  PRISMHR = 'prismhr',
  // Phase 972: Spec 5042 — Terraform Industries company careers plugin
  TERRAFORMINDUSTRIES = 'terraformindustries',
  // Phase 973: Spec 5043 — Submit4Jobs (Pereless) ATS plugin
  SUBMIT4JOBS = 'submit4jobs',
  // Phase 974: Spec 5044 — Notion public-page careers plugin (shared, page-id keyed)
  NOTION_PAGES = 'notion-pages',
  // Phase 975: Spec 5045 — Cover (buildcover.com) company careers plugin (Sanity CMS)
  BUILDCOVER = 'buildcover',
  // Phase 976: Spec 5046 — NANO Nuclear Energy (nanonuclearenergy.com) company careers plugin (WordPress/Divi)
  NANONUCLEARENERGY = 'nanonuclearenergy',
  // Phase 977: Spec 5047 — Desktop Metal (desktopmetal.com) company careers plugin (Cloudflare-gated HTML listing + per-role PDF JDs)
  DESKTOPMETAL = 'desktopmetal',
  // Phase 978: Spec 5048 — Avalanche Energy (avalanchefusion.com) company careers plugin (Webflow listing + detail pages, LinkedIn apply)
  AVALANCHEFUSION = 'avalanchefusion',
  // Phase 979: Spec 5049 — Spike Aerospace (spikeaerospace.com) company careers plugin (WordPress REST category posts)
  SPIKEAEROSPACE = 'spikeaerospace',
  // Phase 980: Spec 5050 — CaneKast (canekast.com) company careers plugin (WordPress/Elementor listing + per-role PDF JDs)
  CANEKAST = 'canekast',
  // Phase 981: Spec 5051 — Velontra (velontra.com) company careers plugin (WordPress/Beaver Builder inline accordion roles)
  VELONTRA = 'velontra',
  // Phase 982: Spec 5052 — Solideon (solideon.com) company careers plugin (WordPress/Elementor listing + per-role detail pages)
  SOLIDEON = 'solideon',
  // Phase 983: Spec 5053 — Galadyne (galadyne.io) company careers plugin (Next.js listing HTML + client-chunk job descriptions)
  GALADYNE_IO = 'galadyne_io',
  // Phase 984: Spec 5054 — Gusto-hosted multi-tenant job boards (jobs.gusto.com/boards/<slug>); distinct from GUSTO (Gusto, Inc.'s own careers)
  GUSTO_HOSTED = 'gusto_hosted',
  // Phase 985: Spec 5056 — ReElement Technologies (reelementtech.com) company careers plugin (Webflow CMS listing + /jobs/<slug> detail)
  REELEMENTTECH = 'reelementtech',
  // Phase 986: Spec 5057 — FLYMOTION (flymotionus.com) company careers plugin (Webflow CMS listing + /jobs/<slug> detail; HubSpot apply form)
  FLYMOTIONUS = 'flymotionus',
  // Phase 987: Spec 5059 — IperionX (iperionx.com) company careers plugin (WordPress summary-only board; apply links out to Indeed, not scraped)
  IPERIONX = 'iperionx',
  // Phase 988: Spec 5061 — Hylio (hyl.io) company careers plugin (Webflow CMS listing + /hiring/<slug> detail; apply links out to Indeed, not scraped)
  HYL_IO = 'hyl_io',
  // Phase 989: Spec 5062 — True Metal Supply (truemetalsupply.com) company careers plugin (Wix popup/lightbox JDs; headless BrowserPool; title-only location)
  TRUEMETALSUPPLY = 'truemetalsupply',
  // Phase 990: Spec 5063 — Framework Automation (framework.co) company careers plugin (Framer SSG; two-step /hiring -> /jobs/{slug}; stated location + salary; apply -> shared /apply form)
  FRAMEWORK_CO = 'framework_co',
  // Phase 991: Spec 5064 — Terminus Industrials (terminusindustrials.com) company careers plugin (Next.js SSR; single-page /careers with inline JD; stated location + employment type; apply -> on-page modal form)
  TERMINUSINDUSTRIALS = 'terminusindustrials',
  // Phase 992: Spec 5065 — Mara Defense (mara.inc) company careers plugin (Webflow SSR; single-page /career cards; stated location + employment type; apply -> LinkedIn, link-only)
  MARA_INC = 'mara_inc',
  // Phase 993: Spec 5066 — Vight (vightaero.com) company careers plugin (hand-coded static HTML; two-step /join-us -> /join-us/{slug}; stated location + employment type; apply -> Cloudflare-obfuscated join@ email)
  VIGHTAERO = 'vightaero',
  // Phase 970: Spec 976 — Source Company Plugin: Airwallex
  AIRWALLEX = 'airwallex',
  // Phase 971: Spec 977 — Source Company Plugin: Renuity
  RENUITY = 'renuity',
  // Phase 972: Spec 978 — Source Company Plugin: Enpal
  ENPAL = 'enpal',
  // Phase 973: Spec 979 — Source Company Plugin: Crusoe
  CRUSOE = 'crusoe',
  // Phase 974: Spec 980 — Source Company Plugin: Harvey
  HARVEY = 'harvey',
  // Phase 975: Spec 981 — Source Company Plugin: Saronic Technologies
  SARONIC_TECHNOLOGIES = 'saronictechnologies',
  // Phase 976: Spec 982 — Source Company Plugin: Applied Intuition
  APPLIED_INTUITION = 'appliedintuition',
  // Phase 977: Spec 983 — Source Company Plugin: Lightspeed Commerce
  LIGHTSPEED_COMMERCE = 'lightspeedcommerce',
  // Phase 978: Spec 984 — Source Company Plugin: Deliveroo
  DELIVEROO = 'deliveroo',
  // Phase 979: Spec 985 — Source Company Plugin: Talkiatry
  TALKIATRY = 'talkiatry',
  // Phase 980: Spec 986 — Source Company Plugin: Base Power Company
  BASE_POWER_COMPANY = 'basepowercompany',
  // Phase 981: Spec 987 — Source Company Plugin: Sailor Health
  SAILOR_HEALTH = 'sailorhealth',
  // Phase 982: Spec 988 — Source Company Plugin: Notion
  NOTION = 'notion',
  // Phase 983: Spec 989 — Source Company Plugin: ElevenLabs
  ELEVENLABS = 'elevenlabs',
  // Phase 984: Spec 990 — Source Company Plugin: Sierra
  SIERRA = 'sierra',
  // Phase 985: Spec 991 — Source Company Plugin: Harmattan AI
  HARMATTAN_AI = 'harmattanai',
  // Phase 986: Spec 992 — Source Company Plugin: SonderMind
  SONDERMIND = 'sondermind',
  // Phase 987: Spec 993 — Source Company Plugin: Cohere
  COHERE = 'cohere',
  // Phase 988: Spec 994 — Source Company Plugin: Neo Financial
  NEO_FINANCIAL = 'neofinancial',
  // Phase 989: Spec 995 — Source Company Plugin: Ramp
  RAMP = 'ramp',
  // Phase 990: Spec 996 — Source Company Plugin: Hopper
  HOPPER = 'hopper',
  // Phase 991: Spec 997 — Source Company Plugin: Hadrian
  HADRIAN = 'hadrian',
  // Phase 992: Spec 998 — Source Company Plugin: Skydio
  SKYDIO = 'skydio',
  // Phase 993: Spec 999 — Source Company Plugin: Decagon
  DECAGON = 'decagon',
  // Phase 994: Spec 1000 — Source Company Plugin: TRM Labs
  TRM_LABS = 'trmlabs',
  // Phase 995: Spec 1001 — Source Company Plugin: Cursor (Anysphere)
  CURSOR_ANYSPHERE = 'cursoranysphere',
  // Phase 996: Spec 1002 — Source Company Plugin: Vanta
  VANTA = 'vanta',
  // Phase 997: Spec 1003 — Source Company Plugin: LangChain
  LANGCHAIN = 'langchain',
  // Phase 998: Spec 1004 — Source Company Plugin: The Exploration Company
  THE_EXPLORATION_COMPANY = 'theexplorationcompany',
  // Phase 999: Spec 1005 — Source Company Plugin: Replit
  REPLIT = 'replit',
  // Phase 1000: Spec 1006 — Source Company Plugin: Socure
  SOCURE = 'socure',
  // Phase 1001: Spec 1007 — Source Company Plugin: Finni Health
  FINNI_HEALTH = 'finnihealth',
  // Phase 1002: Spec 1008 — Source Company Plugin: Kong Inc.
  KONG_INC = 'konginc',
  // Phase 1003: Spec 1009 — Source Company Plugin: Mach Industries
  MACH_INDUSTRIES = 'machindustries',
  // Phase 1004: Spec 1010 — Source Company Plugin: Sprinter Health
  SPRINTER_HEALTH = 'sprinterhealth',
  // Phase 1005: Spec 1011 — Source Company Plugin: Radiant Industries
  RADIANT_INDUSTRIES = 'radiantindustries',
  // Phase 1006: Spec 1012 — Source Company Plugin: Clay
  CLAY = 'clay',
  // Phase 1007: Spec 1013 — Source Company Plugin: Perplexity
  PERPLEXITY = 'perplexity',
  // Phase 1008: Spec 1014 — Source Company Plugin: Cognition
  COGNITION = 'cognition',
  // Phase 1009: Spec 1015 — Source Company Plugin: Hinge Health
  HINGE_HEALTH = 'hingehealth',
  // Phase 1010: Spec 1016 — Source Company Plugin: Synthesia
  SYNTHESIA = 'synthesia',
  // Phase 1011: Spec 1017 — Source Company Plugin: ClickUp
  CLICKUP = 'clickup',
  // Phase 1012: Spec 1018 — Source Company Plugin: Baseten
  BASETEN = 'baseten',
  // Phase 1013: Spec 1019 — Source Company Plugin: Delinea
  DELINEA = 'delinea',
  // Phase 1014: Spec 1020 — Source Company Plugin: Rothy's
  ROTHY_S = 'rothys',
  // Phase 1015: Spec 1021 — Source Company Plugin: CodeRabbit
  CODERABBIT = 'coderabbit',
  // Phase 1016: Spec 1022 — Source Company Plugin: Northwood Space
  NORTHWOOD_SPACE = 'northwoodspace',
  // Phase 1017: Spec 1023 — Source Company Plugin: Reliable Robotics
  RELIABLE_ROBOTICS = 'reliablerobotics',
  // Phase 1018: Spec 1024 — Source Company Plugin: Deepgram
  DEEPGRAM = 'deepgram',
  // Phase 1019: Spec 1025 — Source Company Plugin: Suno
  SUNO = 'suno',
  // Phase 1020: Spec 1026 — Source Company Plugin: Abby Care
  ABBY_CARE = 'abbycare',
  // Phase 1021: Spec 1027 — Source Company Plugin: Lendable
  LENDABLE = 'lendable',
  // Phase 1022: Spec 1028 — Source Company Plugin: Polymarket
  POLYMARKET = 'polymarket',
  // Phase 1023: Spec 1029 — Source Company Plugin: Abridge
  ABRIDGE = 'abridge',
  // Phase 1024: Spec 1030 — Source Company Plugin: Temporal Technologies
  TEMPORAL_TECHNOLOGIES = 'temporaltechnologies',
  // Phase 1025: Spec 1031 — Source Company Plugin: TENEX.AI
  TENEX_AI = 'tenexai',
  // Phase 1026: Spec 1032 — Source Company Plugin: Supabase
  SUPABASE = 'supabase',
  // Phase 1027: Spec 1033 — Source Company Plugin: Encord
  ENCORD = 'encord',
  // Phase 1028: Spec 1034 — Source Company Plugin: Confluent
  CONFLUENT = 'confluent',
  // Phase 1029: Spec 1035 — Source Company Plugin: Cowboy Space Corp.
  COWBOY_SPACE_CORP = 'cowboyspacecorp',
  // Phase 1030: Spec 1036 — Source Company Plugin: Writer
  WRITER = 'writer',
  // Phase 1031: Spec 1037 — Source Company Plugin: Sentry
  SENTRY = 'sentry',
  // Phase 1032: Spec 1038 — Source Company Plugin: Serve Robotics
  SERVE_ROBOTICS = 'serverobotics',
  // Phase 1033: Spec 1039 — Source Company Plugin: Blockstream
  BLOCKSTREAM = 'blockstream',
  // Phase 1034: Spec 1040 — Source Company Plugin: Chainalysis
  CHAINALYSIS = 'chainalysis',
  // Phase 1035: Spec 1041 — Source Company Plugin: RepRally
  REPRALLY = 'reprally',
  // Phase 1036: Spec 1042 — Source Company Plugin: Equip Health
  EQUIP_HEALTH = 'equiphealth',
  // Phase 1037: Spec 1043 — Source Company Plugin: Gamma
  GAMMA = 'gamma',
  // Phase 1038: Spec 1044 — Source Company Plugin: Candid Health
  CANDID_HEALTH = 'candidhealth',
  // Phase 1039: Spec 1045 — Source Company Plugin: SentiLink
  SENTILINK = 'sentilink',
  // Phase 1040: Spec 1046 — Source Company Plugin: Antares Industries
  ANTARES_INDUSTRIES = 'antaresindustries',
  // Phase 1041: Spec 1047 — Source Company Plugin: AeroVect
  AEROVECT = 'aerovect',
  // Phase 1042: Spec 1048 — Source Company Plugin: Munich Electrification
  MUNICH_ELECTRIFICATION = 'munichelectrification',
  // Phase 1043: Spec 1049 — Source Company Plugin: Dash0
  DASH0 = 'dash0',
  // Phase 1044: Spec 1050 — Source Company Plugin: Antares (Antares Industries)
  ANTARES_ANTARES_INDUSTRIES = 'antaresantaresindustries',
  // Phase 1045: Spec 1051 — Source Company Plugin: Lambda
  LAMBDA = 'lambda',
  // Phase 1046: Spec 1052 — Source Company Plugin: Miro
  MIRO = 'miro',
  // Phase 1047: Spec 1053 — Source Company Plugin: Proxima Fusion
  PROXIMA_FUSION = 'proximafusion',
  // Phase 1048: Spec 1054 — Source Company Plugin: Sardine
  SARDINE = 'sardine',
  // Phase 1049: Spec 1055 — Source Company Plugin: Meshy
  MESHY = 'meshy',
  // Phase 1050: Spec 1056 — Source Company Plugin: SPAN
  SPAN = 'span',
  // Phase 1051: Spec 1057 — Source Company Plugin: Cartesia
  CARTESIA = 'cartesia',
  // Phase 1052: Spec 1058 — Source Company Plugin: Modal
  MODAL = 'modal',
  // Phase 1053: Spec 1059 — Source Company Plugin: RobCo
  ROBCO = 'robco',
  // Phase 1054: Spec 1060 — Source Company Plugin: Rula
  RULA = 'rula',
  // Phase 1055: Spec 1061 — Source Company Plugin: Bedrock Robotics
  BEDROCK_ROBOTICS = 'bedrockrobotics',
  // Phase 1056: Spec 1062 — Source Company Plugin: OnePay
  ONEPAY = 'onepay',
  // Phase 1057: Spec 1063 — Source Company Plugin: Qualified Health
  QUALIFIED_HEALTH = 'qualifiedhealth',
  // Phase 1058: Spec 1064 — Source Company Plugin: Reonic
  REONIC = 'reonic',
  // Phase 1059: Spec 1065 — Source Company Plugin: Swap
  SWAP = 'swap',
  // Phase 1060: Spec 1066 — Source Company Plugin: Taptap Send
  TAPTAP_SEND = 'taptapsend',
  // Phase 1061: Spec 1067 — Source Company Plugin: BRINC
  BRINC = 'brinc',
  // Phase 1062: Spec 1068 — Source Company Plugin: Venti Technologies
  VENTI_TECHNOLOGIES = 'ventitechnologies',
  // Phase 1063: Spec 1069 — Source Company Plugin: Oscilar
  OSCILAR = 'oscilar',
  // Phase 1064: Spec 1070 — Source Company Plugin: Semperis
  SEMPERIS = 'semperis',
  // Phase 1065: Spec 1071 — Source Company Plugin: WorkOS
  WORKOS = 'workos',
  // Phase 1066: Spec 1072 — Source Company Plugin: Droyd
  DROYD = 'droyd',
  // Phase 1067: Spec 1073 — Source Company Plugin: Semgrep
  SEMGREP = 'semgrep',
  // Phase 1068: Spec 1074 — Source Company Plugin: Omni
  OMNI = 'omni',
  // Phase 1069: Spec 1075 — Source Company Plugin: Standard Bots
  STANDARD_BOTS = 'standardbots',
  // Phase 1070: Spec 1076 — Source Company Plugin: AIM Intelligent Machines
  AIM_INTELLIGENT_MACHINES = 'aimintelligentmachines',
  // Phase 1071: Spec 1077 — Source Company Plugin: Linear
  LINEAR = 'linear',
  // Phase 1072: Spec 1078 — Source Company Plugin: Sanity
  SANITY = 'sanity',
  // Phase 1073: Spec 1079 — Source Company Plugin: Vertical Aerospace
  VERTICAL_AEROSPACE = 'verticalaerospace',
  // Phase 1074: Spec 1080 — Source Company Plugin: Brigit
  BRIGIT = 'brigit',
  // Phase 1075: Spec 1081 — Source Company Plugin: HackerOne
  HACKERONE = 'hackerone',
  // Phase 1076: Spec 1082 — Source Company Plugin: Observable Space
  OBSERVABLE_SPACE = 'observablespace',
  // Phase 1077: Spec 1083 — Source Company Plugin: Render
  RENDER = 'render',
  // Phase 1078: Spec 1084 — Source Company Plugin: Hive Health
  HIVE_HEALTH = 'hivehealth',
  // Phase 1079: Spec 1085 — Source Company Plugin: incident.io
  INCIDENT_IO = 'incidentio',
  // Phase 1080: Spec 1086 — Source Company Plugin: Mind Robotics
  MIND_ROBOTICS = 'mindrobotics',
  // Phase 1081: Spec 1087 — Source Company Plugin: Periodic Labs
  PERIODIC_LABS = 'periodiclabs',
  // Phase 1082: Spec 1088 — Source Company Plugin: Aspora
  ASPORA = 'aspora',
  // Phase 1083: Spec 1089 — Source Company Plugin: Gecko Robotics
  GECKO_ROBOTICS = 'geckorobotics',
  // Phase 1084: Spec 1090 — Source Company Plugin: PostHog
  POSTHOG = 'posthog',
  // Phase 1085: Spec 1091 — Source Company Plugin: Bicara Therapeutics
  BICARA_THERAPEUTICS = 'bicaratherapeutics',
  // Phase 1086: Spec 1092 — Source Company Plugin: SigNoz
  SIGNOZ = 'signoz',
  // Phase 1087: Spec 1093 — Source Company Plugin: Dust
  DUST = 'dust',
  // Phase 1088: Spec 1094 — Source Company Plugin: Fuse Energy
  FUSE_ENERGY = 'fuseenergy',
  // Phase 1089: Spec 1095 — Source Company Plugin: Havoc AI
  HAVOC_AI = 'havocai',
  // Phase 1090: Spec 1096 — Source Company Plugin: SE3 Labs
  SE3_LABS = 'se3labs',
  // Phase 1091: Spec 1097 — Source Company Plugin: TigerData (Timescale)
  TIGERDATA_TIMESCALE = 'tigerdatatimescale',
  // Phase 1092: Spec 1098 — Source Company Plugin: Arlo
  ARLO = 'arlo',
  // Phase 1093: Spec 1099 — Source Company Plugin: Blue Energy
  BLUE_ENERGY = 'blueenergy',
  // Phase 1094: Spec 1100 — Source Company Plugin: Character.AI
  CHARACTER_AI = 'characterai',
  // Phase 1095: Spec 1101 — Source Company Plugin: Foundry Robotics
  FOUNDRY_ROBOTICS = 'foundryrobotics',
  // Phase 1096: Spec 1102 — Source Company Plugin: Lead Bank
  LEAD_BANK = 'leadbank',
  // Phase 1097: Spec 1103 — Source Company Plugin: Zapier
  ZAPIER = 'zapier',
  // Phase 1098: Spec 1104 — Source Company Plugin: Column
  COLUMN = 'column',
  // Phase 1099: Spec 1105 — Source Company Plugin: Gorgias
  GORGIAS = 'gorgias',
  // Phase 1100: Spec 1106 — Source Company Plugin: Notable
  NOTABLE = 'notable',
  // Phase 1101: Spec 1107 — Source Company Plugin: Tapcart
  TAPCART = 'tapcart',
  // Phase 1102: Spec 1108 — Source Company Plugin: Trust Wallet
  TRUST_WALLET = 'trustwallet',
  // Phase 1103: Spec 1109 — Source Company Plugin: Adaptive Security
  ADAPTIVE_SECURITY = 'adaptivesecurity',
  // Phase 1104: Spec 1110 — Source Company Plugin: Mintlify
  MINTLIFY = 'mintlify',
  // Phase 1105: Spec 1111 — Source Company Plugin: Netspend
  NETSPEND = 'netspend',
  // Phase 1106: Spec 1112 — Source Company Plugin: TAR
  TAR = 'tar',
  // Phase 1107: Spec 1113 — Source Company Plugin: Airbyte
  AIRBYTE = 'airbyte',
  // Phase 1108: Spec 1114 — Source Company Plugin: Allium
  ALLIUM = 'allium',
  // Phase 1109: Spec 1115 — Source Company Plugin: Blossom Health
  BLOSSOM_HEALTH = 'blossomhealth',
  // Phase 1110: Spec 1116 — Source Company Plugin: Genomics plc
  GENOMICS_PLC = 'genomicsplc',
  // Phase 1111: Spec 1117 — Source Company Plugin: insitro
  INSITRO = 'insitro',
  // Phase 1112: Spec 1118 — Source Company Plugin: Laurel
  LAUREL = 'laurel',
  // Phase 1113: Spec 1119 — Source Company Plugin: Method Financial
  METHOD_FINANCIAL = 'methodfinancial',
  // Phase 1114: Spec 1120 — Source Company Plugin: Orb
  ORB = 'orb',
  // Phase 1115: Spec 1121 — Source Company Plugin: Pylon
  PYLON = 'pylon',
  // Phase 1116: Spec 1122 — Source Company Plugin: Anagram
  ANAGRAM = 'anagram',
  // Phase 1117: Spec 1123 — Source Company Plugin: Axle Energy
  AXLE_ENERGY = 'axleenergy',
  // Phase 1118: Spec 1124 — Source Company Plugin: OpenEvidence
  OPENEVIDENCE = 'openevidence',
  // Phase 1119: Spec 1125 — Source Company Plugin: Secfix
  SECFIX = 'secfix',
  // Phase 1120: Spec 1126 — Source Company Plugin: The Bot Company
  THE_BOT_COMPANY = 'thebotcompany',
  // Phase 1121: Spec 1127 — Source Company Plugin: Charge Robotics
  CHARGE_ROBOTICS = 'chargerobotics',
  // Phase 1122: Spec 1128 — Source Company Plugin: Common Room
  COMMON_ROOM = 'commonroom',
  // Phase 1123: Spec 1129 — Source Company Plugin: Compa
  COMPA = 'compa',
  // Phase 1124: Spec 1130 — Source Company Plugin: Fiddler AI
  FIDDLER_AI = 'fiddlerai',
  // Phase 1125: Spec 1131 — Source Company Plugin: Healthtech-1
  HEALTHTECH_1 = 'healthtech1',
  // Phase 1126: Spec 1132 — Source Company Plugin: Mindpeak
  MINDPEAK = 'mindpeak',
  // Phase 1127: Spec 1133 — Source Company Plugin: Tempo
  TEMPO = 'tempo',
  // Phase 1128: Spec 1134 — Source Company Plugin: ZeroMark
  ZEROMARK = 'zeromark',
  // Phase 1129: Spec 1135 — Source Company Plugin: Namespace
  NAMESPACE = 'namespace',
  // Phase 1130: Spec 1136 — Source Company Plugin: OP Labs
  OP_LABS = 'oplabs',
  // Phase 1131: Spec 1137 — Source Company Plugin: Overview Energy
  OVERVIEW_ENERGY = 'overviewenergy',
  // Phase 1132: Spec 1138 — Source Company Plugin: Railway
  RAILWAY = 'railway',
  // Phase 1133: Spec 1139 — Source Company Plugin: Unit
  UNIT = 'unit',
  // Phase 1134: Spec 1140 — Source Company Plugin: Astra Security
  ASTRA_SECURITY = 'astrasecurity',
  // Phase 1135: Spec 1141 — Source Company Plugin: Codes Health
  CODES_HEALTH = 'codeshealth',
  // Phase 1136: Spec 1142 — Source Company Plugin: GridCARE
  GRIDCARE = 'gridcare',
  // Phase 1137: Spec 1143 — Source Company Plugin: Highbeam
  HIGHBEAM = 'highbeam',
  // Phase 1138: Spec 1144 — Source Company Plugin: Infisical
  INFISICAL = 'infisical',
  // Phase 1139: Spec 1145 — Source Company Plugin: Matia
  MATIA = 'matia',
  // Phase 1140: Spec 1146 — Source Company Plugin: Monte Carlo
  MONTE_CARLO = 'montecarlo',
  // Phase 1141: Spec 1147 — Source Company Plugin: Resend
  RESEND = 'resend',
  // Phase 1142: Spec 1148 — Source Company Plugin: WindRanger Labs
  WINDRANGER_LABS = 'windrangerlabs',
  // Phase 1143: Spec 1149 — Source Company Plugin: Assured
  ASSURED = 'assured',
  // Phase 1144: Spec 1150 — Source Company Plugin: Aurora Solar
  AURORA_SOLAR = 'aurorasolar',
  // Phase 1145: Spec 1151 — Source Company Plugin: Dave
  DAVE = 'dave',
  // Phase 1146: Spec 1152 — Source Company Plugin: Escape
  ESCAPE = 'escape',
  // Phase 1147: Spec 1153 — Source Company Plugin: Fiducial
  FIDUCIAL = 'fiducial',
  // Phase 1148: Spec 1154 — Source Company Plugin: Fin
  FIN = 'fin',
  // Phase 1149: Spec 1155 — Source Company Plugin: Neon
  NEON = 'neon',
  // Phase 1150: Spec 1156 — Source Company Plugin: Oso
  OSO = 'oso',
  // Phase 1151: Spec 1157 — Source Company Plugin: Pika
  PIKA = 'pika',
  // Phase 1152: Spec 1158 — Source Company Plugin: Prophet Security
  PROPHET_SECURITY = 'prophetsecurity',
  // Phase 1153: Spec 1159 — Source Company Plugin: Reality Defender
  REALITY_DEFENDER = 'realitydefender',
  // Phase 1154: Spec 1160 — Source Company Plugin: Reka
  REKA = 'reka',
  // Phase 1155: Spec 1161 — Source Company Plugin: Keyrock
  KEYROCK = 'keyrock',
  // Phase 1156: Spec 1162 — Source Company Plugin: Lindus Health
  LINDUS_HEALTH = 'lindushealth',
  // Phase 1157: Spec 1163 — Source Company Plugin: Material Security
  MATERIAL_SECURITY = 'materialsecurity',
  // Phase 1158: Spec 1164 — Source Company Plugin: MotherDuck
  MOTHERDUCK = 'motherduck',
  // Phase 1159: Spec 1165 — Source Company Plugin: Paxos Labs
  PAXOS_LABS = 'paxoslabs',
  // Phase 1160: Spec 1166 — Source Company Plugin: Speakeasy
  SPEAKEASY = 'speakeasy',
  // Phase 1161: Spec 1167 — Source Company Plugin: Electric Air
  ELECTRIC_AIR = 'electricair',
  // Phase 1162: Spec 1168 — Source Company Plugin: Finary
  FINARY = 'finary',
  // Phase 1163: Spec 1169 — Source Company Plugin: Gravity Climate
  GRAVITY_CLIMATE = 'gravityclimate',
  // Phase 1164: Spec 1170 — Source Company Plugin: Inspiration Commerce Group
  INSPIRATION_COMMERCE_GROUP = 'inspirationcommercegroup',
  // Phase 1165: Spec 1171 — Source Company Plugin: Isometric
  ISOMETRIC = 'isometric',
  // Phase 1166: Spec 1172 — Source Company Plugin: Lightspark
  LIGHTSPARK = 'lightspark',
  // Phase 1167: Spec 1173 — Source Company Plugin: NewOrbit Space
  NEWORBIT_SPACE = 'neworbitspace',
  // Phase 1168: Spec 1174 — Source Company Plugin: Prefect
  PREFECT = 'prefect',
  // Phase 1169: Spec 1175 — Source Company Plugin: Reflect Orbital
  REFLECT_ORBITAL = 'reflectorbital',
  // Phase 1170: Spec 1176 — Source Company Plugin: Stytch
  STYTCH = 'stytch',
  // Phase 1171: Spec 1177 — Source Company Plugin: TOMS
  TOMS = 'toms',
  // Phase 1172: Spec 1178 — Source Company Plugin: Twelve
  TWELVE = 'twelve',
  // Phase 1173: Spec 1179 — Source Company Plugin: Hims & Hers (You Health)
  HIMS_HERS_YOU_HEALTH = 'himshersyouhealth',
  // Phase 1174: Spec 1180 — Source Company Plugin: Asimov
  ASIMOV = 'asimov',
  // Phase 1175: Spec 1181 — Source Company Plugin: Doppler
  DOPPLER = 'doppler',
  // Phase 1176: Spec 1182 — Source Company Plugin: Lotus Health
  LOTUS_HEALTH = 'lotushealth',
  // Phase 1177: Spec 1183 — Source Company Plugin: MediCircle
  MEDICIRCLE = 'medicircle',
  // Phase 1178: Spec 1184 — Source Company Plugin: Rebuy
  REBUY = 'rebuy',
  // Phase 1179: Spec 1185 — Source Company Plugin: Standard Subsea
  STANDARD_SUBSEA = 'standardsubsea',
  // Phase 1180: Spec 1186 — Source Company Plugin: Syndica
  SYNDICA = 'syndica',
  // Phase 1181: Spec 1187 — Source Company Plugin: Weaviate
  WEAVIATE = 'weaviate',
  // Phase 1182: Spec 1188 — Source Company Plugin: Contoro Robotics
  CONTORO_ROBOTICS = 'contororobotics',
  // Phase 1183: Spec 1189 — Source Company Plugin: Datafold
  DATAFOLD = 'datafold',
  // Phase 1184: Spec 1190 — Source Company Plugin: DataStealth
  DATASTEALTH = 'datastealth',
  // Phase 1185: Spec 1191 — Source Company Plugin: ReadMe
  README = 'readme',
  // Phase 1186: Spec 1192 — Source Company Plugin: Stargate Foundation
  STARGATE_FOUNDATION = 'stargatefoundation',
  // Phase 1187: Spec 1193 — Source Company Plugin: Svix
  SVIX = 'svix',
  // Phase 1195: Spec 1195 — Source Company Plugin: Above Lending
  ABOVE_LENDING = 'abovelending',
  // Phase 1196: Spec 1196 — Source Company Plugin: Actian
  ACTIAN = 'actian',
  // Phase 1197: Spec 1197 — Source Company Plugin: Agiloft
  AGILOFT = 'agiloft',
  // Phase 1198: Spec 1198 — Source Company Plugin: Aircall
  AIRCALL = 'aircall',
  // Phase 1199: Spec 1199 — Source Company Plugin: Analytic Partners
  ANALYTIC_PARTNERS = 'analyticpartners',
  // Phase 1200: Spec 1200 — Source Company Plugin: Anchorage Digital
  ANCHORAGE_DIGITAL = 'anchorage',
  // Phase 1201: Spec 1201 — Source Company Plugin: ANYbotics
  ANYBOTICS = 'anybotics',
  // Phase 1202: Spec 1202 — Source Company Plugin: Aqemia
  AQEMIA = 'aqemiacom',
  // Phase 1203: Spec 1203 — Source Company Plugin: Arc'teryx
  ARC_TERYX = 'arcteryxcom',
  // Phase 1204: Spec 1204 — Source Company Plugin: Array Labs
  ARRAY_LABS = 'arraylabsio',
  // Phase 1205: Spec 1205 — Source Company Plugin: Arrive Logistics
  ARRIVE_LOGISTICS = 'arrivelogistics',
  // Phase 1206: Spec 1206 — Source Company Plugin: Artera
  ARTERA = 'artera',
  // Phase 1207: Spec 1207 — Source Company Plugin: ASAPP
  ASAPP = 'asapp2',
  // Phase 1208: Spec 1208 — Source Company Plugin: Ataccama
  ATACCAMA = 'ataccama',
  // Phase 1209: Spec 1209 — Source Company Plugin: Avalere Health
  AVALERE_HEALTH = 'avalerehealth',
  // Phase 1210: Spec 1210 — Source Company Plugin: Banner Bank
  BANNER_BANK = 'bannerbank',
  // Phase 1211: Spec 1211 — Source Company Plugin: Binance
  BINANCE = 'binance',
  // Phase 1212: Spec 1212 — Source Company Plugin: BioAgilytix
  BIOAGILYTIX = 'bioagilytix',
  // Phase 1213: Spec 1213 — Source Company Plugin: BoxLunch & Hot Topic
  BOXLUNCH_HOT_TOPIC = 'boxlunch',
  // Phase 1214: Spec 1214 — Source Company Plugin: Brooks Running
  BROOKS_RUNNING = 'brooksrunning',
  // Phase 1215: Spec 1215 — Source Company Plugin: Buck Mason
  BUCK_MASON = 'buckmason',
  // Phase 1216: Spec 1216 — Source Company Plugin: Canvas Medical
  CANVAS_MEDICAL = 'canvasmedical',
  // Phase 1217: Spec 1217 — Source Company Plugin: CaptivateIQ
  CAPTIVATEIQ = 'captivateiq',
  // Phase 1218: Spec 1218 — Source Company Plugin: CareMessage
  CAREMESSAGE = 'caremessage',
  // Phase 1219: Spec 1219 — Source Company Plugin: CertifID
  CERTIFID = 'certifid',
  // Phase 1220: Spec 1220 — Source Company Plugin: CertiK
  CERTIK = 'certik',
  // Phase 1221: Spec 1221 — Source Company Plugin: Commonwealth Fusion Systems
  COMMONWEALTH_FUSION_SYSTEMS = 'cfsenergy',
  // Phase 1222: Spec 1222 — Source Company Plugin: Circadia Health
  CIRCADIA_HEALTH = 'circadiahealth',
  // Phase 1223: Spec 1223 — Source Company Plugin: Cobalt Robotics
  COBALT_ROBOTICS = 'cobaltrobotics',
  // Phase 1224: Spec 1224 — Source Company Plugin: Coins.ph
  COINS_PH = 'coins',
  // Phase 1225: Spec 1225 — Source Company Plugin: Collate
  COLLATE = 'collate',
  // Phase 1226: Spec 1226 — Source Company Plugin: Contentsquare
  CONTENTSQUARE = 'contentsquare',
  // Phase 1227: Spec 1227 — Source Company Plugin: Convelio
  CONVELIO = 'convelio',
  // Phase 1228: Spec 1228 — Source Company Plugin: Conversica
  CONVERSICA = 'conversica',
  // Phase 1229: Spec 1229 — Source Company Plugin: Crypto.com
  CRYPTO_COM = 'crypto',
  // Phase 1230: Spec 1230 — Source Company Plugin: CSC Generation
  CSC_GENERATION = 'cscgeneration2',
  // Phase 1231: Spec 1231 — Source Company Plugin: Centre for Strategic Infocomm Technologies (CSIT)
  CENTRE_FOR_STRATEGIC_INFOCOMM_TECHNOLOGIES_CSIT = 'csit',
  // Phase 1232: Spec 1232 — Source Company Plugin: Cyderes
  CYDERES = 'cyderes',
  // Phase 1233: Spec 1233 — Source Company Plugin: Cyngn
  CYNGN = 'cyngn',
  // Phase 1234: Spec 1234 — Source Company Plugin: Deep Genomics
  DEEP_GENOMICS = 'deepgenomics',
  // Phase 1235: Spec 1235 — Source Company Plugin: DeleteMe
  DELETEME = 'deleteme',
  // Phase 1236: Spec 1236 — Source Company Plugin: Digital Media Management
  DIGITAL_MEDIA_MANAGEMENT = 'digitalmediamanagement',
  // Phase 1237: Spec 1237 — Source Company Plugin: dLocal
  DLOCAL = 'dlocal',
  // Phase 1238: Spec 1238 — Source Company Plugin: Dream Games
  DREAM_GAMES = 'dreamgames',
  // Phase 1239: Spec 1239 — Source Company Plugin: Drivetrain
  DRIVETRAIN = 'drivetrain',
  // Phase 1240: Spec 1240 — Source Company Plugin: DroneDeploy
  DRONEDEPLOY = 'dronedeploy',
  // Phase 1241: Spec 1241 — Source Company Plugin: ECL
  ECL = 'ecldc',
  // Phase 1242: Spec 1242 — Source Company Plugin: Educative
  EDUCATIVE = 'educative',
  // Phase 1243: Spec 1243 — Source Company Plugin: e.l.f. Beauty
  E_L_F_BEAUTY = 'elfbeauty',
  // Phase 1244: Spec 1244 — Source Company Plugin: Energy Recovery
  ENERGY_RECOVERY = 'energyrecovery',
  // Phase 1245: Spec 1245 — Source Company Plugin: Ethena Labs
  ETHENA_LABS = 'ethenalabs',
  // Phase 1246: Spec 1246 — Source Company Plugin: Everlywell
  EVERLYWELL = 'everlywell',
  // Phase 1247: Spec 1247 — Source Company Plugin: Evident
  EVIDENT = 'evidentid',
  // Phase 1248: Spec 1248 — Source Company Plugin: Exploding Kittens
  EXPLODING_KITTENS = 'explodingkittens',
  // Phase 1249: Spec 1249 — Source Company Plugin: Field AI
  FIELD_AI = 'fieldai',
  // Phase 1250: Spec 1250 — Source Company Plugin: Field Nation
  FIELD_NATION = 'fieldnation',
  // Phase 1251: Spec 1251 — Source Company Plugin: Findem
  FINDEM = 'findem',
  // Phase 1252: Spec 1252 — Source Company Plugin: Finix
  FINIX = 'finix',
  // Phase 1253: Spec 1253 — Source Company Plugin: FINN
  FINN = 'finn',
  // Phase 1254: Spec 1254 — Source Company Plugin: FinQuery
  FINQUERY = 'finquery',
  // Phase 1255: Spec 1255 — Source Company Plugin: Foundation EGI
  FOUNDATION_EGI = 'foundationllmtechnologies',
  // Phase 1256: Spec 1256 — Source Company Plugin: Foxit
  FOXIT = 'foxitsoftware',
  // Phase 1257: Spec 1257 — Source Company Plugin: Freedom Solar Power
  FREEDOM_SOLAR_POWER = 'freedomsolarpower',
  // Phase 1258: Spec 1258 — Source Company Plugin: Fun.xyz
  FUN_XYZ = 'funxyz',
  // Phase 1259: Spec 1259 — Source Company Plugin: GenBio AI
  GENBIO_AI = 'genbio',
  // Phase 1260: Spec 1260 — Source Company Plugin: Glass Health
  GLASS_HEALTH = 'glasshealthinc',
  // Phase 1261: Spec 1261 — Source Company Plugin: Global Lending Services
  GLOBAL_LENDING_SERVICES = 'glsllc',
  // Phase 1262: Spec 1262 — Source Company Plugin: HighLevel
  HIGHLEVEL = 'gohighlevel',
  // Phase 1263: Spec 1263 — Source Company Plugin: Good American
  GOOD_AMERICAN = 'goodamerican',
  // Phase 1264: Spec 1264 — Source Company Plugin: GoodLeap
  GOODLEAP = 'goodleap',
  // Phase 1265: Spec 1265 — Source Company Plugin: Gopuff
  GOPUFF = 'gopuff',
  // Phase 1266: Spec 1266 — Source Company Plugin: GRAIL
  GRAIL = 'grailbio',
  // Phase 1267: Spec 1267 — Source Company Plugin: Grand Games
  GRAND_GAMES = 'grand',
  // Phase 1268: Spec 1268 — Source Company Plugin: Gravis Robotics
  GRAVIS_ROBOTICS = 'gravisrobotics',
  // Phase 1269: Spec 1269 — Source Company Plugin: Greenlight Financial Technology
  GREENLIGHT_FINANCIAL_TECHNOLOGY = 'greenlight',
  // Phase 1270: Spec 1270 — Source Company Plugin: Gridware
  GRIDWARE = 'gridware',
  // Phase 1271: Spec 1271 — Source Company Plugin: H1
  H1 = 'h1',
  // Phase 1272: Spec 1272 — Source Company Plugin: HappyCo
  HAPPYCO = 'happyco',
  // Phase 1273: Spec 1273 — Source Company Plugin: Heartbeat Health
  HEARTBEAT_HEALTH = 'heartbeathealth',
  // Phase 1274: Spec 1274 — Source Company Plugin: Hevo Data
  HEVO_DATA = 'hevodata',
  // Phase 1275: Spec 1275 — Source Company Plugin: Rowan
  ROWAN = 'heyrowan',
  // Phase 1276: Spec 1276 — Source Company Plugin: Highspot
  HIGHSPOT = 'highspot',
  // Phase 1277: Spec 1277 — Source Company Plugin: High Tech High
  HIGH_TECH_HIGH = 'hightechhigh',
  // Phase 1278: Spec 1278 — Source Company Plugin: Hive
  HIVE = 'hive',
  // Phase 1279: Spec 1279 — Source Company Plugin: HONK
  HONK = 'honkforhelp',
  // Phase 1280: Spec 1280 — Source Company Plugin: Humble
  HUMBLE = 'humblerobotics',
  // Phase 1281: Spec 1281 — Source Company Plugin: Institute of Foundation Models
  INSTITUTE_OF_FOUNDATION_MODELS = 'ifmus',
  // Phase 1282: Spec 1282 — Source Company Plugin: Included Health
  INCLUDED_HEALTH = 'includedhealth',
  // Phase 1283: Spec 1283 — Source Company Plugin: InfStones
  INFSTONES = 'infstones',
  // Phase 1284: Spec 1284 — Source Company Plugin: Insider
  INSIDER = 'insiderone',
  // Phase 1285: Spec 1285 — Source Company Plugin: Intersect Power
  INTERSECT_POWER = 'intersect',
  // Phase 1286: Spec 1286 — Source Company Plugin: ISEE
  ISEE = 'isee',
  // Phase 1287: Spec 1287 — Source Company Plugin: JumpCloud
  JUMPCLOUD = 'jumpcloud',
  // Phase 1288: Spec 1288 — Source Company Plugin: Kepler Communications
  KEPLER_COMMUNICATIONS = 'kepler',
  // Phase 1289: Spec 1289 — Source Company Plugin: KIPP SoCal Public Schools
  KIPP_SOCAL_PUBLIC_SCHOOLS = 'kippsocal',
  // Phase 1290: Spec 1290 — Source Company Plugin: Knix
  KNIX = 'knix',
  // Phase 1291: Spec 1291 — Source Company Plugin: Kraken
  KRAKEN = 'kraken123',
  // Phase 1292: Spec 1292 — Source Company Plugin: Larian Studios
  LARIAN_STUDIOS = 'larian',
  // Phase 1293: Spec 1293 — Source Company Plugin: Lendbuzz
  LENDBUZZ = 'lendbuzz',
  // Phase 1294: Spec 1294 — Source Company Plugin: Limit Break
  LIMIT_BREAK = 'limitbreak',
  // Phase 1295: Spec 1295 — Source Company Plugin: Loft Orbital Solutions
  LOFT_ORBITAL_SOLUTIONS = 'loftorbital',
  // Phase 1296: Spec 1296 — Source Company Plugin: Lyra Health
  LYRA_HEALTH = 'lyrahealth',
  // Phase 1297: Spec 1297 — Source Company Plugin: Madhappy
  MADHAPPY = 'madhappy',
  // Phase 1298: Spec 1298 — Source Company Plugin: Magnopus
  MAGNOPUS = 'magnopus',
  // Phase 1299: Spec 1299 — Source Company Plugin: Mainspring Energy
  MAINSPRING_ENERGY = 'mainspringenergy',
  // Phase 1300: Spec 1300 — Source Company Plugin: Matillion
  MATILLION = 'matillion',
  // Phase 1301: Spec 1301 — Source Company Plugin: Metabase
  METABASE = 'metabase',
  // Phase 1302: Spec 1302 — Source Company Plugin: Minted
  MINTED = 'minted',
  // Phase 1303: Spec 1303 — Source Company Plugin: Mistral AI
  MISTRAL_AI = 'mistral',
  // Phase 1304: Spec 1304 — Source Company Plugin: MoonPay
  MOONPAY = 'moonpay',
  // Phase 1305: Spec 1305 — Source Company Plugin: Mujin
  MUJIN = 'mujininc',
  // Phase 1306: Spec 1306 — Source Company Plugin: Multiply Labs
  MULTIPLY_LABS = 'multiplylabs',
  // Phase 1307: Spec 1307 — Source Company Plugin: Nium
  NIUM = 'nium',
  // Phase 1308: Spec 1308 — Source Company Plugin: N-Power Medicine
  N_POWER_MEDICINE = 'npowermedicine',
  // Phase 1309: Spec 1309 — Source Company Plugin: Octopus Energy Group
  OCTOPUS_ENERGY_GROUP = 'octoenergy',
  // Phase 1310: Spec 1310 — Source Company Plugin: Offchain Labs
  OFFCHAIN_LABS = 'offchainlabs',
  // Phase 1311: Spec 1311 — Source Company Plugin: Olo
  OLO = 'olo',
  // Phase 1312: Spec 1312 — Source Company Plugin: Orb Aerospace
  ORB_AEROSPACE = 'orbaerospace',
  // Phase 1313: Spec 1313 — Source Company Plugin: OSARO
  OSARO = 'osaro',
  // Phase 1314: Spec 1314 — Source Company Plugin: Outreach
  OUTREACH = 'outreach',
  // Phase 1315: Spec 1315 — Source Company Plugin: Palantir Technologies
  PALANTIR_TECHNOLOGIES = 'palantir',
  // Phase 1316: Spec 1316 — Source Company Plugin: Pattern
  PATTERN = 'pattern',
  // Phase 1317: Spec 1317 — Source Company Plugin: PayJoy
  PAYJOY = 'payjoy',
  // Phase 1318: Spec 1318 — Source Company Plugin: Paytm
  PAYTM = 'paytm',
  // Phase 1319: Spec 1319 — Source Company Plugin: Peak
  PEAK = 'peakgames',
  // Phase 1320: Spec 1320 — Source Company Plugin: Pickle Robot Company
  PICKLE_ROBOT_COMPANY = 'picklerobot',
  // Phase 1321: Spec 1321 — Source Company Plugin: Pivot Energy
  PIVOT_ENERGY = 'pivotenergy',
  // Phase 1322: Spec 1322 — Source Company Plugin: Princess Polly
  PRINCESS_POLLY = 'princesspolly',
  // Phase 1323: Spec 1323 — Source Company Plugin: Proof
  PROOF = 'proof',
  // Phase 1324: Spec 1324 — Source Company Plugin: Quantum Metric
  QUANTUM_METRIC = 'quantummetric',
  // Phase 1325: Spec 1325 — Source Company Plugin: Range Energy
  RANGE_ENERGY = 'rangeenergy',
  // Phase 1326: Spec 1326 — Source Company Plugin: Rapid Micro Biosystems
  RAPID_MICRO_BIOSYSTEMS = 'rapidmicrobio',
  // Phase 1327: Spec 1327 — Source Company Plugin: Red Canyon Engineering & Software
  RED_CANYON_ENGINEERING_SOFTWARE = 'redcanyonsoftware',
  // Phase 1328: Spec 1328 — Source Company Plugin: Redox
  REDOX = 'redoxengine',
  // Phase 1329: Spec 1329 — Source Company Plugin: Regal
  REGAL = 'regalai',
  // Phase 1330: Spec 1330 — Source Company Plugin: Relay Robotics
  RELAY_ROBOTICS = 'relayroboticscom',
  // Phase 1331: Spec 1331 — Source Company Plugin: Revefi
  REVEFI = 'revefi',
  // Phase 1332: Spec 1332 — Source Company Plugin: Revinate
  REVINATE = 'revinate',
  // Phase 1333: Spec 1333 — Source Company Plugin: Safe Security
  SAFE_SECURITY = 'safe',
  // Phase 1334: Spec 1334 — Source Company Plugin: Salvo Health
  SALVO_HEALTH = 'salvohealth',
  // Phase 1335: Spec 1335 — Source Company Plugin: Samba TV
  SAMBA_TV = 'sambatv',
  // Phase 1336: Spec 1336 — Source Company Plugin: Serotonin
  SEROTONIN = 'serotonin',
  // Phase 1337: Spec 1337 — Source Company Plugin: Shield AI
  SHIELD_AI = 'shieldai',
  // Phase 1338: Spec 1338 — Source Company Plugin: Smile Digital Health
  SMILE_DIGITAL_HEALTH = 'smiledigitalhealth',
  // Phase 1339: Spec 1339 — Source Company Plugin: Solar Landscape
  SOLAR_LANDSCAPE = 'solarlandscape',
  // Phase 1340: Spec 1340 — Source Company Plugin: Solestial
  SOLESTIAL = 'solestial',
  // Phase 1341: Spec 1341 — Source Company Plugin: Spear AI
  SPEAR_AI = 'spearai',
  // Phase 1342: Spec 1342 — Source Company Plugin: Spotify
  SPOTIFY = 'spotify',
  // Phase 1343: Spec 1343 — Source Company Plugin: Spreetail
  SPREETAIL = 'spreetail',
  // Phase 1344: Spec 1344 — Source Company Plugin: Spyke Games
  SPYKE_GAMES = 'spykegames',
  // Phase 1345: Spec 1345 — Source Company Plugin: StudyPoint
  STUDYPOINT = 'studypoint',
  // Phase 1346: Spec 1346 — Source Company Plugin: Sun Studio
  SUN_STUDIO = 'sunstudio',
  // Phase 1347: Spec 1347 — Source Company Plugin: Sword Health
  SWORD_HEALTH = 'swordhealth',
  // Phase 1348: Spec 1348 — Source Company Plugin: Synapticure
  SYNAPTICURE = 'synapticure',
  // Phase 1349: Spec 1349 — Source Company Plugin: Sysdig
  SYSDIG = 'sysdig',
  // Phase 1350: Spec 1350 — Source Company Plugin: Tahoe Therapeutics
  TAHOE_THERAPEUTICS = 'tahoebioai',
  // Phase 1351: Spec 1351 — Source Company Plugin: Teleo
  TELEO = 'teleo',
  // Phase 1352: Spec 1352 — Source Company Plugin: The Athletic
  THE_ATHLETIC = 'theathletic',
  // Phase 1353: Spec 1353 — Source Company Plugin: Traackr
  TRAACKR = 'traackr',
  // Phase 1354: Spec 1354 — Source Company Plugin: Trendyol
  TRENDYOL = 'trendyol',
  // Phase 1355: Spec 1355 — Source Company Plugin: Trial Library
  TRIAL_LIBRARY = 'triallibrary',
  // Phase 1356: Spec 1356 — Source Company Plugin: True Zero Technologies
  TRUE_ZERO_TECHNOLOGIES = 'truezerotech',
  // Phase 1357: Spec 1357 — Source Company Plugin: Trustly
  TRUSTLY = 'trustly',
  // Phase 1358: Spec 1358 — Source Company Plugin: Jeeves
  JEEVES = 'tryjeeves',
  // Phase 1359: Spec 1359 — Source Company Plugin: RIOT
  RIOT = 'tryriot',
  // Phase 1360: Spec 1360 — Source Company Plugin: UltraViolet Cyber
  ULTRAVIOLET_CYBER = 'uvcyber',
  // Phase 1361: Spec 1361 — Source Company Plugin: Venus Aerospace
  VENUS_AEROSPACE = 'venusaero',
  // Phase 1362: Spec 1362 — Source Company Plugin: Verifiable
  VERIFIABLE = 'verifiable',
  // Phase 1363: Spec 1363 — Source Company Plugin: Versapay
  VERSAPAY = 'versapay',
  // Phase 1364: Spec 1364 — Source Company Plugin: Vevo
  VEVO = 'vevo',
  // Phase 1365: Spec 1365 — Source Company Plugin: Voltus
  VOLTUS = 'voltus',
  // Phase 1366: Spec 1366 — Source Company Plugin: Waabi
  WAABI = 'waabi',
  // Phase 1367: Spec 1367 — Source Company Plugin: WatchGuard Technologies
  WATCHGUARD_TECHNOLOGIES = 'watchguard',
  // Phase 1368: Spec 1368 — Source Company Plugin: Wealthfront
  WEALTHFRONT = 'wealthfront',
  // Phase 1369: Spec 1369 — Source Company Plugin: WHOOP
  WHOOP = 'whoop',
  // Phase 1370: Spec 1370 — Source Company Plugin: Windfall
  WINDFALL = 'windfalldata',
  // Phase 1371: Spec 1371 — Source Company Plugin: Wintermute
  WINTERMUTE = 'wintermutetrading',
  // Phase 1372: Spec 1372 — Source Company Plugin: Xcimer Energy
  XCIMER_ENERGY = 'xcimer',
  // Phase 1373: Spec 1373 — Source Company Plugin: Xsolla
  XSOLLA = 'xsolla',
  // Phase 1374: Spec 1374 — Source Company Plugin: Zoox
  ZOOX = 'zoox',
  // Phase 1376: Spec 1376 — Source Company Plugin: AbbVie
  ABBVIE = 'abbvie',
  // Phase 1377: Spec 1377 — Source Company Plugin: Abercrombie & Fitch Co.
  ABERCROMBIE_FITCH_CO = 'abercrombiefitchco',
  // Phase 1378: Spec 1378 — Source Company Plugin: AB InBev
  AB_INBEV = 'abinbev',
  // Phase 1379: Spec 1379 — Source Company Plugin: Accor
  ACCOR = 'accor',
  // Phase 1380: Spec 1380 — Source Company Plugin: Achieve
  ACHIEVE = 'achieve',
  // Phase 1381: Spec 1381 — Source Company Plugin: Aditi Staffing
  ADITI_STAFFING = 'aditistaffing',
  // Phase 1382: Spec 1382 — Source Company Plugin: AECOM
  AECOM = 'aecom',
  // Phase 1383: Spec 1383 — Source Company Plugin: AFRY
  AFRY = 'afry',
  // Phase 1384: Spec 1384 — Source Company Plugin: Air New Zealand
  AIR_NEW_ZEALAND = 'airnewzealand',
  // Phase 1385: Spec 1385 — Source Company Plugin: Allegis Global Solutions
  ALLEGIS_GLOBAL_SOLUTIONS = 'allegisglobalsolutions',
  // Phase 1386: Spec 1386 — Source Company Plugin: Alnylam Pharmaceuticals
  ALNYLAM_PHARMACEUTICALS = 'alnylampharmaceuticals',
  // Phase 1387: Spec 1387 — Source Company Plugin: Alpadia Language Schools
  ALPADIA_LANGUAGE_SCHOOLS = 'alpadialanguageschools',
  // Phase 1388: Spec 1388 — Source Company Plugin: ALTEN
  ALTEN = 'alten',
  // Phase 1389: Spec 1389 — Source Company Plugin: De Beers Group
  DE_BEERS_GROUP = 'debeersgroup',
  // Phase 1390: Spec 1390 — Source Company Plugin: Arete Technologies
  ARETE_TECHNOLOGIES = 'aretetechnologies',
  // Phase 1391: Spec 1391 — Source Company Plugin: Arista Networks
  ARISTA_NETWORKS = 'aristanetworks',
  // Phase 1392: Spec 1392 — Source Company Plugin: Artech
  ARTECH = 'artech',
  // Phase 1393: Spec 1393 — Source Company Plugin: Artelia
  ARTELIA = 'artelia',
  // Phase 1394: Spec 1394 — Source Company Plugin: Ask IT Consulting
  ASK_IT_CONSULTING = 'askitconsulting',
  // Phase 1395: Spec 1395 — Source Company Plugin: Assent
  ASSENT = 'assent',
  // Phase 1396: Spec 1396 — Source Company Plugin: Assystem
  ASSYSTEM = 'assystem',
  // Phase 1397: Spec 1397 — Source Company Plugin: Atria Group
  ATRIA_GROUP = 'atriagroup',
  // Phase 1398: Spec 1398 — Source Company Plugin: Auberge Resorts Collection
  AUBERGE_RESORTS_COLLECTION = 'aubergeresortscollection',
  // Phase 1399: Spec 1399 — Source Company Plugin: Avaloq
  AVALOQ = 'avaloq',
  // Phase 1400: Spec 1400 — Source Company Plugin: Avance Consulting Services
  AVANCE_CONSULTING_SERVICES = 'avanceconsultingservices',
  // Phase 1401: Spec 1401 — Source Company Plugin: AVIV Group
  AVIV_GROUP = 'avivgroup',
  // Phase 1402: Spec 1402 — Source Company Plugin: BCforward
  BCFORWARD = 'bcforward',
  // Phase 1403: Spec 1403 — Source Company Plugin: Believe
  BELIEVE = 'believe',
  // Phase 1404: Spec 1404 — Source Company Plugin: Bosch Home Comfort
  BOSCH_HOME_COMFORT = 'boschhomecomfort',
  // Phase 1405: Spec 1405 — Source Company Plugin: Bosch Group
  BOSCH_GROUP = 'boschgroup',
  // Phase 1406: Spec 1406 — Source Company Plugin: Boyd Gaming
  BOYD_GAMING = 'boydgaming',
  // Phase 1407: Spec 1407 — Source Company Plugin: Bruegger's Bagels
  BRUEGGER_S_BAGELS = 'brueggersbagels',
  // Phase 1408: Spec 1408 — Source Company Plugin: Cardinal Logistics
  CARDINAL_LOGISTICS = 'cardinallogistics',
  // Phase 1409: Spec 1409 — Source Company Plugin: Carilion Clinic
  CARILION_CLINIC = 'carilionclinic',
  // Phase 1410: Spec 1410 — Source Company Plugin: Cielo
  CIELO = 'cielo',
  // Phase 1411: Spec 1411 — Source Company Plugin: CIMA+
  CIMA = 'cima',
  // Phase 1412: Spec 1412 — Source Company Plugin: City and County of San Francisco
  CITY_AND_COUNTY_OF_SAN_FRANCISCO = 'cityandcountyofsanfrancisco',
  // Phase 1413: Spec 1413 — Source Company Plugin: City Furniture
  CITY_FURNITURE = 'cityfurniture',
  // Phase 1414: Spec 1414 — Source Company Plugin: City of Philadelphia
  CITY_OF_PHILADELPHIA = 'cityofphiladelphia',
  // Phase 1415: Spec 1415 — Source Company Plugin: City of San Antonio
  CITY_OF_SAN_ANTONIO = 'cityofsanantonio',
  // Phase 1416: Spec 1416 — Source Company Plugin: Columbia University
  COLUMBIA_UNIVERSITY = 'columbiauniversity',
  // Phase 1417: Spec 1417 — Source Company Plugin: Constance Hotels & Resorts
  CONSTANCE_HOTELS_RESORTS = 'constancehotelsresorts',
  // Phase 1418: Spec 1418 — Source Company Plugin: Contact Energy
  CONTACT_ENERGY = 'contactenergy',
  // Phase 1419: Spec 1419 — Source Company Plugin: Continental
  CONTINENTAL = 'continental',
  // Phase 1420: Spec 1420 — Source Company Plugin: Cornerstone Building Brands
  CORNERSTONE_BUILDING_BRANDS = 'cornerstonebuildingbrands',
  // Phase 1421: Spec 1421 — Source Company Plugin: County of Grande Prairie No. 1
  COUNTY_OF_GRANDE_PRAIRIE_NO_1 = 'countyofgrandeprairieno1',
  // Phase 1422: Spec 1422 — Source Company Plugin: Covista
  COVISTA = 'covista',
  // Phase 1423: Spec 1423 — Source Company Plugin: CRB
  CRB = 'crb',
  // Phase 1424: Spec 1424 — Source Company Plugin: CROSSMARK
  CROSSMARK = 'crossmark',
  // Phase 1425: Spec 1425 — Source Company Plugin: Cruise Planners
  CRUISE_PLANNERS = 'cruiseplanners',
  // Phase 1426: Spec 1426 — Source Company Plugin: Customized Energy Solutions
  CUSTOMIZED_ENERGY_SOLUTIONS = 'customizedenergysolutions',
  // Phase 1427: Spec 1427 — Source Company Plugin: CVUK
  CVUK = 'cvuk',
  // Phase 1428: Spec 1428 — Source Company Plugin: Delivery Hero
  DELIVERY_HERO = 'deliveryhero',
  // Phase 1429: Spec 1429 — Source Company Plugin: Deloitte
  DELOITTE = 'deloitte',
  // Phase 1430: Spec 1430 — Source Company Plugin: Deloitte (Nordic)
  DELOITTE_NORDIC = 'deloittenordic',
  // Phase 1431: Spec 1431 — Source Company Plugin: Deloitte New Zealand
  DELOITTE_NEW_ZEALAND = 'deloittenewzealand',
  // Phase 1432: Spec 1432 — Source Company Plugin: Delta Electronics
  DELTA_ELECTRONICS = 'deltaelectronics',
  // Phase 1433: Spec 1433 — Source Company Plugin: Derex Technologies
  DEREX_TECHNOLOGIES = 'derextechnologies',
  // Phase 1434: Spec 1434 — Source Company Plugin: Deutsche Telekom IT Solutions
  DEUTSCHE_TELEKOM_IT_SOLUTIONS = 'deutschetelekomitsolutions',
  // Phase 1435: Spec 1435 — Source Company Plugin: Deutsche Telekom IT Solutions Slovakia
  DEUTSCHE_TELEKOM_IT_SOLUTIONS_SLOVAKIA = 'deutschetelekomitsolutionsslovakia',
  // Phase 1436: Spec 1436 — Source Company Plugin: Dexterra Group
  DEXTERRA_GROUP = 'dexterragroup',
  // Phase 1437: Spec 1437 — Source Company Plugin: Eataly
  EATALY = 'eataly',
  // Phase 1438: Spec 1438 — Source Company Plugin: EcoVadis
  ECOVADIS = 'ecovadis',
  // Phase 1439: Spec 1439 — Source Company Plugin: EDF UK
  EDF_UK = 'edfuk',
  // Phase 1440: Spec 1440 — Source Company Plugin: Educational Connections
  EDUCATIONAL_CONNECTIONS = 'educationalconnections',
  // Phase 1441: Spec 1441 — Source Company Plugin: Egis Group
  EGIS_GROUP = 'egisgroup',
  // Phase 1442: Spec 1442 — Source Company Plugin: EMCO Corporation
  EMCO_CORPORATION = 'emcocorporation',
  // Phase 1443: Spec 1443 — Source Company Plugin: Entain
  ENTAIN = 'entain',
  // Phase 1444: Spec 1444 — Source Company Plugin: Entertainment Benefits Group
  ENTERTAINMENT_BENEFITS_GROUP = 'entertainmentbenefitsgroup',
  // Phase 1445: Spec 1445 — Source Company Plugin: Entire Hire
  ENTIRE_HIRE = 'entirehire',
  // Phase 1446: Spec 1446 — Source Company Plugin: eTalent
  ETALENT = 'etalent',
  // Phase 1447: Spec 1447 — Source Company Plugin: Etihad Airways
  ETIHAD_AIRWAYS = 'etihadairways',
  // Phase 1448: Spec 1448 — Source Company Plugin: Eurofins Scientific
  EUROFINS_SCIENTIFIC = 'eurofinsscientific',
  // Phase 1449: Spec 1449 — Source Company Plugin: EVERSANA
  EVERSANA = 'eversana',
  // Phase 1450: Spec 1450 — Source Company Plugin: Evolution
  EVOLUTION = 'evolution',
  // Phase 1451: Spec 1451 — Source Company Plugin: Expeditors
  EXPEDITORS = 'expeditors',
  // Phase 1452: Spec 1452 — Source Company Plugin: Experian
  EXPERIAN = 'experian',
  // Phase 1453: Spec 1453 — Source Company Plugin: Fortune Brands Innovations
  FORTUNE_BRANDS_INNOVATIONS = 'fortunebrandsinnovations',
  // Phase 1454: Spec 1454 — Source Company Plugin: Freshworks
  FRESHWORKS = 'freshworks',
  // Phase 1455: Spec 1455 — Source Company Plugin: Frontier Technologies
  FRONTIER_TECHNOLOGIES = 'frontiertechnologies',
  // Phase 1456: Spec 1456 — Source Company Plugin: Gameloft
  GAMELOFT = 'gameloft',
  // Phase 1457: Spec 1457 — Source Company Plugin: GE HealthCare
  GE_HEALTHCARE = 'gehealthcare',
  // Phase 1458: Spec 1458 — Source Company Plugin: Gousto
  GOUSTO = 'gousto',
  // Phase 1459: Spec 1459 — Source Company Plugin: Grupo Mariposa (Regional)
  GRUPO_MARIPOSA_REGIONAL = 'grupomariposaregional',
  // Phase 1460: Spec 1460 — Source Company Plugin: Grupo Mariposa
  GRUPO_MARIPOSA = 'grupomariposa',
  // Phase 1461: Spec 1461 — Source Company Plugin: Halton Healthcare
  HALTON_HEALTHCARE = 'haltonhealthcare',
  // Phase 1462: Spec 1462 — Source Company Plugin: Healthcare Support Staffing
  HEALTHCARE_SUPPORT_STAFFING = 'healthcaresupportstaffing',
  // Phase 1463: Spec 1463 — Source Company Plugin: HealthEast
  HEALTHEAST = 'healtheast',
  // Phase 1464: Spec 1464 — Source Company Plugin: HealthPartners
  HEALTHPARTNERS = 'healthpartners',
  // Phase 1465: Spec 1465 — Source Company Plugin: Hillstone Restaurant Group
  HILLSTONE_RESTAURANT_GROUP = 'hillstonerestaurantgroup',
  // Phase 1466: Spec 1466 — Source Company Plugin: Hoist Group
  HOIST_GROUP = 'hoistgroup',
  // Phase 1467: Spec 1467 — Source Company Plugin: Hume City Council
  HUME_CITY_COUNCIL = 'humecitycouncil',
  // Phase 1468: Spec 1468 — Source Company Plugin: ib vogt
  IB_VOGT = 'ibvogt',
  // Phase 1469: Spec 1469 — Source Company Plugin: ICTS (UK) Ltd
  ICTS_UK_LTD = 'ictsukltd',
  // Phase 1470: Spec 1470 — Source Company Plugin: iHeartMedia
  IHEARTMEDIA = 'iheartmedia',
  // Phase 1471: Spec 1471 — Source Company Plugin: Iliad / Free
  ILIAD_FREE = 'iliadfree',
  // Phase 1472: Spec 1472 — Source Company Plugin: Implement Consulting Group
  IMPLEMENT_CONSULTING_GROUP = 'implementconsultinggroup',
  // Phase 1473: Spec 1473 — Source Company Plugin: Infojini
  INFOJINI = 'infojini',
  // Phase 1474: Spec 1474 — Source Company Plugin: Inter IKEA Group
  INTER_IKEA_GROUP = 'interikeagroup',
  // Phase 1475: Spec 1475 — Source Company Plugin: Intuitive Surgical
  INTUITIVE_SURGICAL = 'intuitivesurgical',
  // Phase 1476: Spec 1476 — Source Company Plugin: JG Wentworth Home Lending
  JG_WENTWORTH_HOME_LENDING = 'jgwentworthhomelending',
  // Phase 1477: Spec 1477 — Source Company Plugin: Jobs for Humanity
  JOBS_FOR_HUMANITY = 'jobsforhumanity',
  // Phase 1478: Spec 1478 — Source Company Plugin: Keywords Studios
  KEYWORDS_STUDIOS = 'keywordsstudios',
  // Phase 1479: Spec 1479 — Source Company Plugin: Kioxia
  KIOXIA = 'kioxia',
  // Phase 1480: Spec 1480 — Source Company Plugin: KIPP
  KIPP = 'kipp',
  // Phase 1481: Spec 1481 — Source Company Plugin: Kittitas Valley Healthcare
  KITTITAS_VALLEY_HEALTHCARE = 'kittitasvalleyhealthcare',
  // Phase 1482: Spec 1482 — Source Company Plugin: Korsail Energy
  KORSAIL_ENERGY = 'korsailenergy',
  // Phase 1483: Spec 1483 — Source Company Plugin: Lakeshore Learning Materials
  LAKESHORE_LEARNING_MATERIALS = 'lakeshorelearningmaterials',
  // Phase 1484: Spec 1484 — Source Company Plugin: Lasan Group
  LASAN_GROUP = 'lasangroup',
  // Phase 1485: Spec 1485 — Source Company Plugin: LGC Group
  LGC_GROUP = 'lgcgroup',
  // Phase 1486: Spec 1486 — Source Company Plugin: Live Nation Entertainment
  LIVE_NATION_ENTERTAINMENT = 'livenationentertainment',
  // Phase 1487: Spec 1487 — Source Company Plugin: Longbridge Financial
  LONGBRIDGE_FINANCIAL = 'longbridgefinancial',
  // Phase 1488: Spec 1488 — Source Company Plugin: LVMH
  LVMH = 'lvmh',
  // Phase 1489: Spec 1489 — Source Company Plugin: LVMH Perfumes & Cosmetics
  LVMH_PERFUMES_COSMETICS = 'lvmhperfumescosmetics',
  // Phase 1490: Spec 1490 — Source Company Plugin: Mannarino Systems & Software
  MANNARINO_SYSTEMS_SOFTWARE = 'mannarinosystemssoftware',
  // Phase 1491: Spec 1491 — Source Company Plugin: Masdar
  MASDAR = 'masdar',
  // Phase 1492: Spec 1492 — Source Company Plugin: MAT Holdings
  MAT_HOLDINGS = 'matholdings',
  // Phase 1493: Spec 1493 — Source Company Plugin: Maxim Integrated
  MAXIM_INTEGRATED = 'maximintegrated',
  // Phase 1494: Spec 1494 — Source Company Plugin: MedHealth
  MEDHEALTH = 'medhealth',
  // Phase 1495: Spec 1495 — Source Company Plugin: Minor International
  MINOR_INTERNATIONAL = 'minorinternational',
  // Phase 1496: Spec 1496 — Source Company Plugin: Mitsubishi Tanabe Pharma America
  MITSUBISHI_TANABE_PHARMA_AMERICA = 'mitsubishitanabepharmaamerica',
  // Phase 1497: Spec 1497 — Source Company Plugin: Nagarro
  NAGARRO = 'nagarro',
  // Phase 1498: Spec 1498 — Source Company Plugin: Natixis in Portugal
  NATIXIS_IN_PORTUGAL = 'natixisinportugal',
  // Phase 1499: Spec 1499 — Source Company Plugin: NBCUniversal
  NBCUNIVERSAL = 'nbcuniversal',
  // Phase 1500: Spec 1500 — Source Company Plugin: Nemera
  NEMERA = 'nemera',
  // Phase 1501: Spec 1501 — Source Company Plugin: Nexthink
  NEXTHINK = 'nexthink',
  // Phase 1502: Spec 1502 — Source Company Plugin: NielsenIQ
  NIELSENIQ = 'nielseniq',
  // Phase 1503: Spec 1503 — Source Company Plugin: NMC Healthcare
  NMC_HEALTHCARE = 'nmchealthcare',
  // Phase 1504: Spec 1504 — Source Company Plugin: North 40 Outfitters
  NORTH_40_OUTFITTERS = 'north40outfitters',
  // Phase 1505: Spec 1505 — Source Company Plugin: North Star Staffing Solutions
  NORTH_STAR_STAFFING_SOLUTIONS = 'northstarstaffingsolutions',
  // Phase 1506: Spec 1506 — Source Company Plugin: Northwestern Medicine
  NORTHWESTERN_MEDICINE = 'northwesternmedicine',
  // Phase 1507: Spec 1507 — Source Company Plugin: O-I Glass
  O_I_GLASS = 'oiglass',
  // Phase 1508: Spec 1508 — Source Company Plugin: Office Depot
  OFFICE_DEPOT = 'officedepot',
  // Phase 1509: Spec 1509 — Source Company Plugin: Ontario Transit Group
  ONTARIO_TRANSIT_GROUP = 'ontariotransitgroup',
  // Phase 1510: Spec 1510 — Source Company Plugin: ORIC Pharmaceuticals
  ORIC_PHARMACEUTICALS = 'oricpharmaceuticals',
  // Phase 1511: Spec 1511 — Source Company Plugin: OUTsurance
  OUTSURANCE = 'outsurance',
  // Phase 1512: Spec 1512 — Source Company Plugin: Oxfam America
  OXFAM_AMERICA = 'oxfamamerica',
  // Phase 1513: Spec 1513 — Source Company Plugin: Paramount
  PARAMOUNT = 'paramount',
  // Phase 1514: Spec 1514 — Source Company Plugin: Park Avenue Coffee
  PARK_AVENUE_COFFEE = 'parkavenuecoffee',
  // Phase 1515: Spec 1515 — Source Company Plugin: PenFinancial Credit Union
  PENFINANCIAL_CREDIT_UNION = 'penfinancialcreditunion',
  // Phase 1516: Spec 1516 — Source Company Plugin: Pericom Semiconductor
  PERICOM_SEMICONDUCTOR = 'pericomsemiconductor',
  // Phase 1517: Spec 1517 — Source Company Plugin: Pilot Company
  PILOT_COMPANY = 'pilotcompany',
  // Phase 1518: Spec 1518 — Source Company Plugin: Platinum Healthcare Staffing
  PLATINUM_HEALTHCARE_STAFFING = 'platinumhealthcarestaffing',
  // Phase 1519: Spec 1519 — Source Company Plugin: PowerGen Renewable Energy
  POWERGEN_RENEWABLE_ENERGY = 'powergenrenewableenergy',
  // Phase 1520: Spec 1520 — Source Company Plugin: PrimeLending
  PRIMELENDING = 'primelending',
  // Phase 1521: Spec 1521 — Source Company Plugin: ProSidian Consulting
  PROSIDIAN_CONSULTING = 'prosidianconsulting',
  // Phase 1522: Spec 1522 — Source Company Plugin: PS Logistics
  PS_LOGISTICS = 'pslogistics',
  // Phase 1523: Spec 1523 — Source Company Plugin: Pyramid Consulting
  PYRAMID_CONSULTING = 'pyramidconsulting',
  // Phase 1524: Spec 1524 — Source Company Plugin: Qantas Group
  QANTAS_GROUP = 'qantasgroup',
  // Phase 1525: Spec 1525 — Source Company Plugin: Quest Diagnostics
  QUEST_DIAGNOSTICS = 'questdiagnostics',
  // Phase 1526: Spec 1526 — Source Company Plugin: Raising Cane's
  RAISING_CANE_S = 'raisingcanes',
  // Phase 1527: Spec 1527 — Source Company Plugin: Ramboll
  RAMBOLL = 'ramboll',
  // Phase 1528: Spec 1528 — Source Company Plugin: Red Bull
  RED_BULL = 'redbull',
  // Phase 1529: Spec 1529 — Source Company Plugin: Relais & Châteaux
  RELAIS_CH_TEAUX = 'relaischteaux',
  // Phase 1530: Spec 1530 — Source Company Plugin: Relief International
  RELIEF_INTERNATIONAL = 'reliefinternational',
  // Phase 1531: Spec 1531 — Source Company Plugin: Renesas Electronics
  RENESAS_ELECTRONICS = 'renesaselectronics',
  // Phase 1532: Spec 1532 — Source Company Plugin: Rexel
  REXEL = 'rexel',
  // Phase 1533: Spec 1533 — Source Company Plugin: Salomon
  SALOMON = 'salomon',
  // Phase 1534: Spec 1534 — Source Company Plugin: SanDisk
  SANDISK = 'sandisk',
  // Phase 1535: Spec 1535 — Source Company Plugin: Scalable Capital
  SCALABLE_CAPITAL = 'scalablecapital',
  // Phase 1536: Spec 1536 — Source Company Plugin: Scalian
  SCALIAN = 'scalian',
  // Phase 1537: Spec 1537 — Source Company Plugin: SEAKR Engineering
  SEAKR_ENGINEERING = 'seakrengineering',
  // Phase 1538: Spec 1538 — Source Company Plugin: Securitas
  SECURITAS = 'securitas',
  // Phase 1539: Spec 1539 — Source Company Plugin: Senior plc
  SENIOR_PLC = 'seniorplc',
  // Phase 1540: Spec 1540 — Source Company Plugin: ServiceNow
  SERVICENOW = 'servicenow',
  // Phase 1541: Spec 1541 — Source Company Plugin: Shaw's
  SHAW_S = 'shaws',
  // Phase 1542: Spec 1542 — Source Company Plugin: Sika
  SIKA = 'sika',
  // Phase 1543: Spec 1543 — Source Company Plugin: Silfab Solar
  SILFAB_SOLAR = 'silfabsolar',
  // Phase 1544: Spec 1544 — Source Company Plugin: Simplisolar
  SIMPLISOLAR = 'simplisolar',
  // Phase 1545: Spec 1545 — Source Company Plugin: SIXT
  SIXT = 'sixt',
  // Phase 1546: Spec 1546 — Source Company Plugin: Smiths Group
  SMITHS_GROUP = 'smithsgroup',
  // Phase 1547: Spec 1547 — Source Company Plugin: Sodexo
  SODEXO = 'sodexo',
  // Phase 1548: Spec 1548 — Source Company Plugin: Sodexo Canada
  SODEXO_CANADA = 'sodexocanada',
  // Phase 1549: Spec 1549 — Source Company Plugin: SpaceKnow
  SPACEKNOW = 'spaceknow',
  // Phase 1550: Spec 1550 — Source Company Plugin: Spectrum Health Care
  SPECTRUM_HEALTH_CARE = 'spectrumhealthcare',
  // Phase 1551: Spec 1551 — Source Company Plugin: Sportradar
  SPORTRADAR = 'sportradar',
  // Phase 1552: Spec 1552 — Source Company Plugin: Staffing Medical USA
  STAFFING_MEDICAL_USA = 'staffingmedicalusa',
  // Phase 1553: Spec 1553 — Source Company Plugin: Standard Bank Group
  STANDARD_BANK_GROUP = 'standardbankgroup',
  // Phase 1554: Spec 1554 — Source Company Plugin: Stanford Medicine Children's Health
  STANFORD_MEDICINE_CHILDREN_S_HEALTH = 'stanfordmedicinechildrenshealth',
  // Phase 1555: Spec 1555 — Source Company Plugin: Statkraft
  STATKRAFT = 'statkraft',
  // Phase 1556: Spec 1556 — Source Company Plugin: Stem Xpert
  STEM_XPERT = 'stemxpert',
  // Phase 1557: Spec 1557 — Source Company Plugin: Stratas Foods
  STRATAS_FOODS = 'stratasfoods',
  // Phase 1558: Spec 1558 — Source Company Plugin: Strategic Staffing Solutions (S3)
  STRATEGIC_STAFFING_SOLUTIONS_S3 = 'strategicstaffingsolutionss3',
  // Phase 1559: Spec 1559 — Source Company Plugin: Structube
  STRUCTUBE = 'structube',
  // Phase 1560: Spec 1560 — Source Company Plugin: Suntiva
  SUNTIVA = 'suntiva',
  // Phase 1561: Spec 1561 — Source Company Plugin: Swiss Hospitality
  SWISS_HOSPITALITY = 'swisshospitality',
  // Phase 1562: Spec 1562 — Source Company Plugin: Symmetry Financial Group
  SYMMETRY_FINANCIAL_GROUP = 'symmetryfinancialgroup',
  // Phase 1563: Spec 1563 — Source Company Plugin: Syngenta Group
  SYNGENTA_GROUP = 'syngentagroup',
  // Phase 1564: Spec 1564 — Source Company Plugin: Talan
  TALAN = 'talan',
  // Phase 1565: Spec 1565 — Source Company Plugin: Telefónica Tech
  TELEF_NICA_TECH = 'telefnicatech',
  // Phase 1566: Spec 1566 — Source Company Plugin: Tessenderlo Group
  TESSENDERLO_GROUP = 'tessenderlogroup',
  // Phase 1567: Spec 1567 — Source Company Plugin: Texas Health Resources
  TEXAS_HEALTH_RESOURCES = 'texashealthresources',
  // Phase 1568: Spec 1568 — Source Company Plugin: The Nielsen Company
  THE_NIELSEN_COMPANY = 'thenielsencompany',
  // Phase 1569: Spec 1569 — Source Company Plugin: The Wonderful Company
  THE_WONDERFUL_COMPANY = 'thewonderfulcompany',
  // Phase 1570: Spec 1570 — Source Company Plugin: Transat AT
  TRANSAT_AT = 'transatat',
  // Phase 1571: Spec 1571 — Source Company Plugin: Truewerk
  TRUEWERK = 'truewerk',
  // Phase 1572: Spec 1572 — Source Company Plugin: Turner & Townsend
  TURNER_TOWNSEND = 'turnertownsend',
  // Phase 1573: Spec 1573 — Source Company Plugin: Ubisoft
  UBISOFT = 'ubisoft',
  // Phase 1574: Spec 1574 — Source Company Plugin: Ulbrich Stainless Steels & Special Metals
  ULBRICH_STAINLESS_STEELS_SPECIAL_METALS = 'ulbrichstainlesssteelsspecialmetals',
  // Phase 1575: Spec 1575 — Source Company Plugin: Uncommon Schools
  UNCOMMON_SCHOOLS = 'uncommonschools',
  // Phase 1576: Spec 1576 — Source Company Plugin: Unit4
  UNIT4 = 'unit4',
  // Phase 1577: Spec 1577 — Source Company Plugin: Unitek Learning
  UNITEK_LEARNING = 'uniteklearning',
  // Phase 1578: Spec 1578 — Source Company Plugin: University of the West of England
  UNIVERSITY_OF_THE_WEST_OF_ENGLAND = 'universityofthewestofengland',
  // Phase 1579: Spec 1579 — Source Company Plugin: Valeo Foods
  VALEO_FOODS = 'valeofoods',
  // Phase 1580: Spec 1580 — Source Company Plugin: Vattenfall
  VATTENFALL = 'vattenfall',
  // Phase 1581: Spec 1581 — Source Company Plugin: Version 1
  VERSION_1 = 'version1',
  // Phase 1582: Spec 1582 — Source Company Plugin: Villa Group
  VILLA_GROUP = 'villagroup',
  // Phase 1583: Spec 1583 — Source Company Plugin: vTech Solution
  VTECH_SOLUTION = 'vtechsolution',
  // Phase 1584: Spec 1584 — Source Company Plugin: Vuori
  VUORI = 'vuori',
  // Phase 1585: Spec 1585 — Source Company Plugin: Western Digital
  WESTERN_DIGITAL = 'westerndigital',
  // Phase 1586: Spec 1586 — Source Company Plugin: William Osler Health System
  WILLIAM_OSLER_HEALTH_SYSTEM = 'williamoslerhealthsystem',
  // Phase 1587: Spec 1587 — Source Company Plugin: Wise
  WISE = 'wise',
  // Phase 1588: Spec 1588 — Source Company Plugin: World Wildlife Fund
  WORLD_WILDLIFE_FUND = 'worldwildlifefund',
  // Phase 1589: Spec 1589 — Source Company Plugin: WSH Group
  WSH_GROUP = 'wshgroup',
  // Phase 1590: Spec 1590 — Source Company Plugin: Wynn Resorts
  WYNN_RESORTS = 'wynnresorts',
  // Phase 1591: Spec 1591 — Source Company Plugin: Xplor Technologies
  XPLOR_TECHNOLOGIES = 'xplortechnologies',
  // Phase 1592: Spec 1592 — Source Company Plugin: Zenith Talent
  ZENITH_TALENT = 'zenithtalent',
  // Phase 1594: Spec 1594 — Source Company Plugin: Aikido Security
  AIKIDO_SECURITY = 'aikidosecurity',
  // Phase 1595: Spec 1595 — Source Company Plugin: Alphacomm
  ALPHACOMM = 'alphacomm',
  // Phase 1596: Spec 1596 — Source Company Plugin: Azumuta
  AZUMUTA = 'azumuta',
  // Phase 1597: Spec 1597 — Source Company Plugin: benuta
  BENUTA = 'benuta',
  // Phase 1598: Spec 1598 — Source Company Plugin: Bluecrux
  BLUECRUX = 'bluecrux',
  // Phase 1599: Spec 1599 — Source Company Plugin: bunq
  BUNQ = 'bunq',
  // Phase 1600: Spec 1600 — Source Company Plugin: cbs Corporate Business Solutions
  CBS_CORPORATE_BUSINESS_SOLUTIONS = 'cbscorporatebusinesssolutions',
  // Phase 1601: Spec 1601 — Source Company Plugin: Centreon
  CENTREON = 'centreon',
  // Phase 1602: Spec 1602 — Source Company Plugin: Centric
  CENTRIC = 'centric',
  // Phase 1603: Spec 1603 — Source Company Plugin: Channable
  CHANNABLE = 'channable',
  // Phase 1604: Spec 1604 — Source Company Plugin: CloudBilling
  CLOUDBILLING = 'cloudbilling',
  // Phase 1605: Spec 1605 — Source Company Plugin: constellr
  CONSTELLR = 'constellr',
  // Phase 1606: Spec 1606 — Source Company Plugin: Craftzing
  CRAFTZING = 'craftzing',
  // Phase 1607: Spec 1607 — Source Company Plugin: Creative Clicks
  CREATIVE_CLICKS = 'creativeclicks',
  // Phase 1608: Spec 1608 — Source Company Plugin: Cyber & Mason (PinDirect)
  CYBER_MASON_PINDIRECT = 'cybermasonpindirect',
  // Phase 1609: Spec 1609 — Source Company Plugin: Dealroom.co
  DEALROOM_CO = 'dealroomco',
  // Phase 1610: Spec 1610 — Source Company Plugin: DEMV Systems
  DEMV_SYSTEMS = 'demvsystems',
  // Phase 1611: Spec 1611 — Source Company Plugin: Distribusion Technologies
  DISTRIBUSION_TECHNOLOGIES = 'distribusiontechnologies',
  // Phase 1612: Spec 1612 — Source Company Plugin: Ecilia
  ECILIA = 'ecilia',
  // Phase 1613: Spec 1613 — Source Company Plugin: Ehrenkind
  EHRENKIND = 'ehrenkind',
  // Phase 1614: Spec 1614 — Source Company Plugin: Elephant Technologies
  ELEPHANT_TECHNOLOGIES = 'elephanttechnologies',
  // Phase 1615: Spec 1615 — Source Company Plugin: epilot
  EPILOT = 'epilot',
  // Phase 1616: Spec 1616 — Source Company Plugin: Faktion
  FAKTION = 'faktion',
  // Phase 1617: Spec 1617 — Source Company Plugin: FieldBuddy
  FIELDBUDDY = 'fieldbuddy',
  // Phase 1618: Spec 1618 — Source Company Plugin: Fietsenwinkel.nl
  FIETSENWINKEL_NL = 'fietsenwinkelnl',
  // Phase 1619: Spec 1619 — Source Company Plugin: Fixico
  FIXICO = 'fixico',
  // Phase 1620: Spec 1620 — Source Company Plugin: Floryn
  FLORYN = 'floryn',
  // Phase 1621: Spec 1621 — Source Company Plugin: GreenFlux
  GREENFLUX = 'greenflux',
  // Phase 1622: Spec 1622 — Source Company Plugin: gridscale
  GRIDSCALE = 'gridscale',
  // Phase 1623: Spec 1623 — Source Company Plugin: Gusti Leder
  GUSTI_LEDER = 'gustileder',
  // Phase 1624: Spec 1624 — Source Company Plugin: Helloprint
  HELLOPRINT = 'helloprint',
  // Phase 1625: Spec 1625 — Source Company Plugin: HEMERIA
  HEMERIA = 'hemeria',
  // Phase 1626: Spec 1626 — Source Company Plugin: Instant System
  INSTANT_SYSTEM = 'instantsystem',
  // Phase 1627: Spec 1627 — Source Company Plugin: Intescia
  INTESCIA = 'intescia',
  // Phase 1628: Spec 1628 — Source Company Plugin: Mistertemp' Group
  MISTERTEMP_GROUP = 'mistertempgroup',
  // Phase 1629: Spec 1629 — Source Company Plugin: Learned
  LEARNED = 'learned',
  // Phase 1630: Spec 1630 — Source Company Plugin: LegalFly
  LEGALFLY = 'legalfly',
  // Phase 1631: Spec 1631 — Source Company Plugin: LOAVIES
  LOAVIES = 'loavies',
  // Phase 1632: Spec 1632 — Source Company Plugin: Look Up Space
  LOOK_UP_SPACE = 'lookupspace',
  // Phase 1633: Spec 1633 — Source Company Plugin: Lucky Cart
  LUCKY_CART = 'luckycart',
  // Phase 1634: Spec 1634 — Source Company Plugin: Makersite
  MAKERSITE = 'makersite',
  // Phase 1635: Spec 1635 — Source Company Plugin: Matera
  MATERA = 'matera',
  // Phase 1636: Spec 1636 — Source Company Plugin: Mobiapps
  MOBIAPPS = 'mobiapps',
  // Phase 1637: Spec 1637 — Source Company Plugin: MobilityPlus
  MOBILITYPLUS = 'mobilityplus',
  // Phase 1638: Spec 1638 — Source Company Plugin: Monizze
  MONIZZE = 'monizze',
  // Phase 1639: Spec 1639 — Source Company Plugin: Mon-marché.fr
  MON_MARCH_FR = 'monmarchfr',
  // Phase 1640: Spec 1640 — Source Company Plugin: Natuvion
  NATUVION = 'natuvion',
  // Phase 1641: Spec 1641 — Source Company Plugin: Nmbrs
  NMBRS = 'nmbrs',
  // Phase 1642: Spec 1642 — Source Company Plugin: Novutech
  NOVUTECH = 'novutech',
  // Phase 1643: Spec 1643 — Source Company Plugin: Ockto
  OCKTO = 'ockto',
  // Phase 1644: Spec 1644 — Source Company Plugin: ON2IT
  ON2IT = 'on2it',
  // Phase 1645: Spec 1645 — Source Company Plugin: Online Payment Platform (OPP)
  ONLINE_PAYMENT_PLATFORM_OPP = 'onlinepaymentplatformopp',
  // Phase 1646: Spec 1646 — Source Company Plugin: Openclaims
  OPENCLAIMS = 'openclaims',
  // Phase 1647: Spec 1647 — Source Company Plugin: OPEN.nl Software Group
  OPEN_NL_SOFTWARE_GROUP = 'opennlsoftwaregroup',
  // Phase 1648: Spec 1648 — Source Company Plugin: Payflows
  PAYFLOWS = 'payflows',
  // Phase 1649: Spec 1649 — Source Company Plugin: Payter
  PAYTER = 'payter',
  // Phase 1650: Spec 1650 — Source Company Plugin: Peddler
  PEDDLER = 'peddler',
  // Phase 1651: Spec 1651 — Source Company Plugin: Peripass
  PERIPASS = 'peripass',
  // Phase 1652: Spec 1652 — Source Company Plugin: Poppy
  POPPY = 'poppy',
  // Phase 1653: Spec 1653 — Source Company Plugin: Prijsvrij Vakanties
  PRIJSVRIJ_VAKANTIES = 'prijsvrijvakanties',
  // Phase 1654: Spec 1654 — Source Company Plugin: Proforto
  PROFORTO = 'proforto',
  // Phase 1655: Spec 1655 — Source Company Plugin: QLF Brands (lampenlicht.nl)
  QLF_BRANDS_LAMPENLICHT_NL = 'qlfbrandslampenlichtnl',
  // Phase 1656: Spec 1656 — Source Company Plugin: Qualifyze
  QUALIFYZE = 'qualifyze',
  // Phase 1657: Spec 1657 — Source Company Plugin: Solutions 4 Delivery
  SOLUTIONS_4_DELIVERY = 'solutions4delivery',
  // Phase 1658: Spec 1658 — Source Company Plugin: Shop Manufaktur
  SHOP_MANUFAKTUR = 'shopmanufaktur',
  // Phase 1659: Spec 1659 — Source Company Plugin: Simvia
  SIMVIA = 'simvia',
  // Phase 1660: Spec 1660 — Source Company Plugin: Spread Group
  SPREAD_GROUP = 'spreadgroup',
  // Phase 1661: Spec 1661 — Source Company Plugin: Staxxer
  STAXXER = 'staxxer',
  // Phase 1662: Spec 1662 — Source Company Plugin: Superellipse
  SUPERELLIPSE = 'superellipse',
  // Phase 1663: Spec 1663 — Source Company Plugin: Superlinear
  SUPERLINEAR = 'superlinear',
  // Phase 1664: Spec 1664 — Source Company Plugin: Technica Engineering
  TECHNICA_ENGINEERING = 'technicaengineering',
  // Phase 1665: Spec 1665 — Source Company Plugin: TOPIC
  TOPIC = 'topic',
  // Phase 1666: Spec 1666 — Source Company Plugin: Trusted Shops
  TRUSTED_SHOPS = 'trustedshops',
  // Phase 1667: Spec 1667 — Source Company Plugin: UP42
  UP42 = 'up42',
  // Phase 1668: Spec 1668 — Source Company Plugin: UpSlide
  UPSLIDE = 'upslide',
  // Phase 1669: Spec 1669 — Source Company Plugin: VALUEZON
  VALUEZON = 'valuezon',
  // Phase 1670: Spec 1670 — Source Company Plugin: VertiGIS
  VERTIGIS = 'vertigis',
  // Phase 1671: Spec 1671 — Source Company Plugin: Vertuoza
  VERTUOZA = 'vertuoza',
  // Phase 1672: Spec 1672 — Source Company Plugin: VIKTOR
  VIKTOR = 'viktor',
  // Phase 1673: Spec 1673 — Source Company Plugin: WATCHVICE (Leingang E-Commerce)
  WATCHVICE_LEINGANG_E_COMMERCE = 'watchviceleingangecommerce',
  // Phase 1674: Spec 1674 — Source Company Plugin: WEBB Traders
  WEBB_TRADERS = 'webbtraders',
  // Phase 1675: Spec 1675 — Source Company Plugin: Weeztix
  WEEZTIX = 'weeztix',
  // Phase 1676: Spec 1676 — Source Company Plugin: XSARUS
  XSARUS = 'xsarus',
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
