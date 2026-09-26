import 'reflect-metadata';
import { postedFromTimestamp } from '@ever-jobs/common';
import { JobType, LocationDto } from '@ever-jobs/models';
import {
  INHIRE_DEFAULT_DETAIL_BUDGET,
  INHIRE_MAX_DETAIL_FETCHES,
} from '../src/inhire.constants';
import {
  bodyMessage,
  buildLocationLabel,
  canonicalJobUrl,
  careerPageUrl,
  cleanListRows,
  cleanText,
  detailBudgetFor,
  employmentTypeLabel,
  firstHttpsUrl,
  foldText,
  htmlToText,
  httpsUrlOrNull,
  latestPostedMs,
  mapContractTypes,
  matchesLocation,
  matchesSearchTerm,
  normaliseHtmlEntities,
  parseInhireTenant,
  parseJsonBody,
  readEnvInt,
  resolveJobUrl,
  tenantDisplayName,
  workplaceFlags,
} from '../src/inhire.helpers';
import { parseLocationList } from '@ever-jobs/common';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('InHire helpers (Spec 1692)', () => {
  describe('parseInhireTenant', () => {
    it.each([
      ['acme-br', 'acme-br'],
      ['ACME-BR', 'acme-br'],
      ['  olist  ', 'olist'],
      ['acme-br.inhire.app', 'acme-br'],
      ['acme-br.inhire.com.br', 'acme-br'],
      ['ACME-BR.INHIRE.APP.', 'acme-br'],
      [`https://acme-br.inhire.com.br/vagas/${UUID}`, 'acme-br'],
      ['https://acme-br.inhire.app/vagas', 'acme-br'],
      ['http://acme-br.inhire.app/', 'acme-br'],
      ['portal', 'portal'],
      ['db1', 'db1'],
    ])('reads %j as tenant %j', (value, expected) => {
      expect(parseInhireTenant(value)).toBe(expected);
    });

    it.each([
      ['evil\r\nX: y'],
      ['evil\nx'],
      ['a b'],
      ['a..b'],
      ['api'],
      ['files'],
      ['www'],
      ['api.inhire.app'],
      ['https://www.inhire.com.br/'],
      ['https://olist.example.com'],
      ['https://olist.inhire.app.evil.example/'],
      ['https://evilinhire.app/'],
      ['https://a.b.inhire.app/'],
      ['https://user:pass@olist.inhire.app/'],
      ['https://olist.inhire.app:8443/'],
      ['ftp://olist.inhire.app/'],
      ['-olist'],
      ['olist-'],
      ['olist_br'],
      ['a'.repeat(64)],
      [''],
      ['   '],
    ])('refuses %j', (value) => {
      expect(parseInhireTenant(value)).toBeNull();
    });

    it('refuses non-strings', () => {
      expect(parseInhireTenant(undefined)).toBeNull();
      expect(parseInhireTenant(null)).toBeNull();
      expect(parseInhireTenant(42 as unknown as string)).toBeNull();
    });

    it('requires a tenant host in host-only mode (companyUrl)', () => {
      expect(parseInhireTenant('olist', { hostOnly: true })).toBeNull();
      expect(parseInhireTenant('olist.inhire.app', { hostOnly: true })).toBe('olist');
      expect(parseInhireTenant('https://olist.inhire.com.br/vagas', { hostOnly: true })).toBe('olist');
    });
  });

  it('de-slugifies a tenant for display', () => {
    expect(tenantDisplayName('acme-br')).toBe('Acme Br');
    expect(tenantDisplayName('olist')).toBe('Olist');
    expect(tenantDisplayName('grupo_protege')).toBe('Grupo Protege');
  });

  it('folds case, accents and whitespace', () => {
    expect(foldText('  Sênior   Estágio ')).toBe('senior estagio');
    expect(foldText(null)).toBe('');
    expect(cleanText('  Desenvolvedor Backend Sênior  ')).toBe('Desenvolvedor Backend Sênior');
    expect(cleanText('a \n\t b')).toBe('a b');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(5)).toBeNull();
  });

  describe('cleanListRows', () => {
    const row = (jobId: unknown, displayName: unknown, link?: unknown) => ({ jobId, displayName, link });

    it('drops rows without a UUID or a title, de-duplicates, keeps order', () => {
      const rows = [
        row(UUID, 'Dev Sênior ', 'https://x.inhire.com.br/vagas/1'),
        row('not-a-uuid', 'Bad id'),
        row('22222222-2222-4222-8222-222222222222', '   '),
        row(UUID.toUpperCase(), 'Duplicate (case differs)'),
        null,
        'text',
        [1, 2],
        row('33333333-3333-4333-8333-333333333333', 'Analista'),
      ];
      const out = cleanListRows(rows, 500);
      expect(out.candidates.map((c) => c.title)).toEqual(['Dev Sênior', 'Analista']);
      expect(out.candidates.map((c) => c.index)).toEqual([0, 1]);
      expect(out.candidates[0].link).toBe('https://x.inhire.com.br/vagas/1');
      expect(out.candidates[1].link).toBeNull();
      expect(out.invalid).toBe(5);
      expect(out.dupe).toBe(1);
      expect(out.truncated).toBe(0);
    });

    it('caps the list before cleaning', () => {
      const rows = Array.from({ length: 7 }, (_, i) =>
        row(`00000000-0000-4000-8000-00000000000${i}`, `Role ${i}`),
      );
      const out = cleanListRows(rows, 5);
      expect(out.candidates).toHaveLength(5);
      expect(out.truncated).toBe(2);
    });
  });

  it('matches every search word in the title, ignoring case and accents', () => {
    expect(matchesSearchTerm('Desenvolvedor Backend Sênior', 'senior')).toBe(true);
    expect(matchesSearchTerm('Desenvolvedor Backend Sênior', 'SÊNIOR backend')).toBe(true);
    expect(matchesSearchTerm('Desenvolvedor Backend Sênior', 'senior frontend')).toBe(false);
    expect(matchesSearchTerm('Estágio em Marketing', 'estagio')).toBe(true);
    expect(matchesSearchTerm('Anything', '')).toBe(true);
    expect(matchesSearchTerm('Anything', undefined)).toBe(true);
  });

  describe('job URLs', () => {
    it('keeps a list link on the tenant host', () => {
      expect(resolveJobUrl(`https://acme-br.inhire.com.br/vagas/${UUID}`, 'acme-br', UUID)).toBe(
        `https://acme-br.inhire.com.br/vagas/${UUID}`,
      );
      expect(resolveJobUrl(`https://acme-br.inhire.app/vagas/${UUID}`, 'acme-br', UUID)).toBe(
        `https://acme-br.inhire.app/vagas/${UUID}`,
      );
    });

    it.each([
      [`https://evil.example.net/vagas/${UUID}`],
      [`https://other.inhire.com.br/vagas/${UUID}`],
      [`https://x.acme-br.inhire.com.br/vagas/${UUID}`],
      [`http://acme-br.inhire.com.br/vagas/${UUID}`],
      [`https://user@acme-br.inhire.com.br/vagas/${UUID}`],
      [`https://acme-br.inhire.com.br:444/vagas/${UUID}`],
      ['javascript:alert(1)'],
      [null],
    ])('replaces %j with the canonical URL', (link) => {
      expect(resolveJobUrl(link, 'acme-br', UUID)).toBe(canonicalJobUrl('acme-br', UUID));
      expect(canonicalJobUrl('acme-br', UUID)).toBe(`https://acme-br.inhire.com.br/vagas/${UUID}`);
    });

    it('derives the career page from the job URL', () => {
      expect(careerPageUrl(`https://acme-br.inhire.com.br/vagas/${UUID}`)).toBe(
        'https://acme-br.inhire.com.br/vagas',
      );
      expect(careerPageUrl('not a url')).toBeNull();
    });
  });

  it('accepts only public https image URLs', () => {
    expect(httpsUrlOrNull('https://files.inhire.app/pages/career/logo.png')).toBe(
      'https://files.inhire.app/pages/career/logo.png',
    );
    expect(httpsUrlOrNull('http://files.inhire.app/logo.png')).toBeNull();
    expect(httpsUrlOrNull('https://127.0.0.1/logo.png')).toBeNull();
    expect(httpsUrlOrNull('https://u:p@files.inhire.app/logo.png')).toBeNull();
    expect(httpsUrlOrNull('data:image/png;base64,AAAA')).toBeNull();
    expect(httpsUrlOrNull(undefined)).toBeNull();
    expect(firstHttpsUrl(['http://a.example.org/x.png', 'https://files.inhire.app/b.png'])).toBe(
      'https://files.inhire.app/b.png',
    );
    expect(firstHttpsUrl([])).toBeNull();
    expect(firstHttpsUrl('https://files.inhire.app/c.png')).toBe('https://files.inhire.app/c.png');
  });

  describe('entities', () => {
    it('decodes named entities and keeps markup escapes', () => {
      expect(normaliseHtmlEntities('<p>miss&atilde;o &amp; &lt;b&gt;</p>')).toBe(
        '<p>missão &amp; &lt;b&gt;</p>',
      );
      expect(normaliseHtmlEntities('no entities')).toBe('no entities');
    });

    it('turns entity-encoded HTML into plain text', () => {
      expect(htmlToText('<p>Remunera&ccedil;&atilde;o: R$ 2.000,00</p><ul><li>Node.js</li></ul>')).toBe(
        'Remuneração: R$ 2.000,00\n• Node.js',
      );
      expect(htmlToText('')).toBeNull();
      expect(htmlToText(null)).toBeNull();
      expect(htmlToText('<p> </p>')).toBeNull();
    });
  });

  describe('buildLocationLabel', () => {
    it.each([
      ['BR', '', 'BR', 'BR'],
      ['br', null, 'BR', 'BR'],
      ['BR', 'São Paulo - SP', 'São Paulo, SP, Brazil', 'BR'],
      ['PT', '', 'PT', 'PT'],
      ['São Paulo', 'SP', 'São Paulo, SP, Brazil', 'BR'],
      ['Curitiba - PR', '', 'Curitiba, PR, Brazil', 'BR'],
      ['Curitiba - PR', 'PR', 'Curitiba, PR, Brazil', 'BR'],
      ['Porto Alegre, RS', '', 'Porto Alegre, RS, Brazil', 'BR'],
      ['Florianópolis/SC', '', 'Florianópolis, SC, Brazil', 'BR'],
      ['Brasil', '', 'Brazil', 'BR'],
      ['São Paulo, Brasil', '', 'São Paulo, Brazil', 'BR'],
      ['Remoto - Brasil', '', 'Brazil', 'BR'],
      ['Belo Horizonte', 'Híbrido', 'Belo Horizonte, Brazil', 'BR'],
      ['Lisboa, Portugal', '', 'Lisboa, Portugal', null],
      ['SP', '', 'SP, Brazil', 'BR'],
    ])('%j + %j → %j (%j)', (location, complement, label, countryCode) => {
      expect(buildLocationLabel(location, complement)).toEqual({ label, countryCode });
    });

    it.each([['Remoto'], ['Presencial'], [''], ['   ']])('%j gives no location', (location) => {
      expect(buildLocationLabel(location, '')).toEqual({ label: null, countryCode: null });
    });

    it('never lets a Brazilian state code read as a country', () => {
      for (const [raw, state] of [
        ['Curitiba - PR', 'PR'],
        ['Porto Alegre, RS', 'RS'],
        ['Joinville, SC', 'SC'],
        ['Vitória, ES', 'ES'],
      ]) {
        const { label } = buildLocationLabel(raw, '');
        const parsed = parseLocationList([label]).location;
        expect(parsed?.state).toBe(state);
        expect(parsed?.country).toBe('Brazil');
      }
    });
  });

  it('matches a location needle part by part, accent-free, Brasil = Brazil', () => {
    const locations = [new LocationDto({ city: 'Curitiba', state: 'PR', country: 'Brazil' })];
    expect(matchesLocation('curitiba', 'Curitiba, PR, Brazil', locations)).toBe(true);
    expect(matchesLocation('Brasil', 'Curitiba, PR, Brazil', locations)).toBe(true);
    expect(matchesLocation('Curitiba, Brasil', 'Curitiba, PR, Brazil', locations)).toBe(true);
    expect(matchesLocation('São Paulo', 'Curitiba, PR, Brazil', locations)).toBe(false);
    expect(matchesLocation('', null, [])).toBe(true);
    expect(matchesLocation('sao paulo', 'São Paulo, SP, Brazil', [])).toBe(true);
    expect(matchesLocation('brazil', 'BR', [new LocationDto({ country: 'Brazil' })])).toBe(true);
  });

  describe('mapContractTypes', () => {
    it.each([
      [['CLT'], null, [JobType.FULL_TIME]],
      [['clt'], null, [JobType.FULL_TIME]],
      [['Efetivo'], null, [JobType.FULL_TIME]],
      [['Trainee'], null, [JobType.FULL_TIME]],
      [['PJ'], null, [JobType.CONTRACT]],
      [['Freelancer'], null, [JobType.CONTRACT]],
      [['Autônomo'], null, [JobType.CONTRACT]],
      [['Cooperado'], null, [JobType.CONTRACT]],
      [['Estágio'], null, [JobType.INTERNSHIP]],
      [['Temporário'], null, [JobType.TEMPORARY]],
      [['Jovem Aprendiz'], null, [JobType.APPRENTICESHIP]],
      [['Aprendiz'], null, [JobType.APPRENTICESHIP]],
      [['CLT', 'PJ', 'CLT'], null, [JobType.FULL_TIME, JobType.CONTRACT]],
      [['Part-time'], null, [JobType.PART_TIME]],
      [[], null, null],
      [['Zzz desconhecido'], null, null],
      [[null, 42, {}], null, null],
      ['CLT', null, [JobType.FULL_TIME]],
      [undefined, null, null],
      [[], 'Estágio em Marketing', [JobType.INTERNSHIP]],
      [['Estágio'], 'Estagiária de Dados', [JobType.INTERNSHIP]],
      [['CLT'], 'Software Engineering Intern', [JobType.FULL_TIME, JobType.INTERNSHIP]],
      [[], 'Internal Auditor', null],
    ])('%j (title %j) → %j', (contractType, title, expected) => {
      expect(mapContractTypes(contractType, title)).toEqual(expected);
    });

    it('joins the raw labels as employmentType', () => {
      expect(employmentTypeLabel(['CLT'])).toBe('CLT');
      expect(employmentTypeLabel(['CLT', ' PJ ', 'CLT'])).toBe('CLT, PJ');
      expect(employmentTypeLabel([])).toBeNull();
      expect(employmentTypeLabel(undefined)).toBeNull();
    });
  });

  it.each([
    ['Remote', true, 'Remote'],
    ['remote', true, 'Remote'],
    ['Remoto', true, 'Remote'],
    ['Hybrid', false, 'Hybrid'],
    ['Híbrido', false, 'Hybrid'],
    ['On-site', false, null],
    [undefined, false, null],
  ])('workplaceType %j → isRemote %j, workFromHomeType %j', (value, isRemote, workFromHomeType) => {
    expect(workplaceFlags(value)).toEqual({ isRemote, workFromHomeType });
  });

  it('takes the latest instant a posting time allows', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    expect(latestPostedMs(postedFromTimestamp('2026-09-20T15:30:00.000Z', now))).toBe(
      Date.parse('2026-09-20T15:30:00.000Z'),
    );
    expect(latestPostedMs(postedFromTimestamp('2026-09-20', now))).toBe(
      Date.parse('2026-09-20T23:59:59.999Z'),
    );
    expect(latestPostedMs(postedFromTimestamp(null, now))).toBeNull();
    expect(latestPostedMs(postedFromTimestamp('garbage', now))).toBeNull();
  });

  it('maps descriptionDepth to a detail budget under the hard ceiling', () => {
    expect(detailBudgetFor('board')).toBe(0);
    expect(detailBudgetFor('detail-25')).toBe(25);
    expect(detailBudgetFor('detail-all')).toBe(INHIRE_MAX_DETAIL_FETCHES);
    expect(detailBudgetFor(undefined)).toBe(INHIRE_DEFAULT_DETAIL_BUDGET);
    expect(detailBudgetFor('something-else')).toBe(INHIRE_DEFAULT_DETAIL_BUDGET);
  });

  describe('readEnvInt', () => {
    const NAME = 'INHIRE_TEST_ENV_INT';
    afterEach(() => {
      delete process.env[NAME];
    });

    it('falls back when unset, blank or not an integer; clamps otherwise', () => {
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(7);
      process.env[NAME] = '  ';
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(7);
      process.env[NAME] = 'abc';
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(7);
      process.env[NAME] = '2.5';
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(7);
      process.env[NAME] = '4';
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(4);
      process.env[NAME] = '0';
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(1);
      process.env[NAME] = '99';
      expect(readEnvInt(NAME, 7, 1, 10)).toBe(10);
    });
  });

  it('reads an error body message and parses text JSON bodies', () => {
    expect(bodyMessage({ message: 'Forbidden' }, 200)).toBe('Forbidden');
    expect(bodyMessage({ message: 'x'.repeat(300) }, 200)).toHaveLength(200);
    expect(bodyMessage({}, 200)).toBeNull();
    expect(bodyMessage([], 200)).toBeNull();
    expect(bodyMessage('Forbidden', 200)).toBeNull();
    expect(parseJsonBody('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseJsonBody(' {"message":"Forbidden"} ')).toEqual({ message: 'Forbidden' });
    expect(parseJsonBody('<html></html>')).toBe('<html></html>');
    expect(parseJsonBody('[broken')).toBe('[broken');
    expect(parseJsonBody([1])).toEqual([1]);
  });
});
