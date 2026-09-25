import type { CareerLevel, CareerLevelInput } from '@ever-jobs/models';
import { CAREER_LEVELS } from '@ever-jobs/models';

import {
  capAtWord,
  classifyCareerLevel,
  DESCRIPTION_NEEDLES,
  MAX_DESCRIPTION_SCAN_CHARS,
  MAX_FIELD_CHARS,
  MAX_REASONS,
  MAX_TITLE_CHARS,
  normalizeCareerText,
} from '../src/career-level.rules';

const level = (title: string, extra: Partial<CareerLevelInput> = {}): CareerLevel =>
  classifyCareerLevel({ title, ...extra }).level;

/** Table helper: every title in `titles` must classify as `expected`. */
function table(expected: CareerLevel, titles: string[]): void {
  it.each(titles)(`%s → ${expected}`, (title) => {
    expect(level(title)).toBe(expected);
  });
}

describe('classifyCareerLevel — rules (Spec 1730)', () => {
  describe('internship cues', () => {
    table('internship', [
      'Software Engineer Intern',
      'INTERN - DATA',
      'Summer Interns',
      'Marketing Internship',
      'Legal Extern',
      'Engineering Co-op',
      'Coop Student - Finance',
      'Summer Analyst',
      'Summer Associate - Litigation',
      'Software Engineer - Summer 2026',
      "Research Engineer - Fall '26",
      'Working Student Sales',
      'Werkstudentin Marketing',
      'Student Worker - Library',
      'Student Researcher',
      'Praktikant Einkauf',
      'Stagiaire Marketing',
      'Stage de fin d’études - Data',
      'Becario de Finanzas',
      'Pasante de Sistemas',
      'Estagiária de Marketing',
      'Tirocinio Ingegneria',
      'Master Thesis - Autonomous Driving',
      'Industrial Placement - Finance',
      'Year in Industry - Software',
      'Graduate Research Assistant',
      'Graduate Teaching Assistant',
      'Undergraduate Research Assistant',
      'Research Experience for Undergraduates',
      '软件工程实习生',
      'インターン（エンジニア）',
      '인턴 - 마케팅',
    ]);

    it('never matches internal / international / internet / interne / internist / interim / interior', () => {
      for (const title of [
        'Internal Tools Engineer',
        'International Sales Representative',
        'Internet Marketing Specialist',
        'Interne en chirurgie',
        'Internist',
        'Interim Controller',
        'Interior Designer',
        'Interpreter',
      ]) {
        expect(level(title)).not.toBe('internship');
      }
    });

    it('never matches "cooperative" and ignores the Co-op retailer', () => {
      expect(level('Cooperative Extension Educator')).toBe('unknown');
      expect(level('Customer Team Member - Co-op Food')).toBe('unknown');
      expect(level('Co-op Funeralcare Arranger')).not.toBe('internship');
    });

    it('a retail co-operative named before "co-op", or a retail job after it, is not a work term', () => {
      for (const title of ['Food Co-op Cashier', 'Co-op Cashier', 'Grocery Co-op Deli Clerk', 'Credit Co-op Teller', 'Co-op Produce Stocker']) {
        const v = classifyCareerLevel({ title });
        expect({ title, level: v.level }).toEqual({ title, level: 'unknown' });
        expect(v.reasons.join(' ')).toMatch(/co-operative business/);
      }
      // A work-term co-op keeps its reading.
      expect(level('Engineering Co-op - Fall 2026')).toBe('internship');
      expect(level('Co-op Student, Finance')).toBe('internship');
    });

    it('treats a seasonal job with a season + year as seasonal, not an internship', () => {
      expect(level('Lifeguard - Summer 2026')).toBe('unknown');
      expect(level('Summer Camp Counselor 2026')).toBe('unknown');
    });

    it('treats a season + year on a teaching / coaching / instructing job as a term, not an internship', () => {
      for (const title of [
        'Adjunct Faculty - Spring 2026',
        'Assistant Professor of Biology - Fall 2026',
        'Lecturer in Economics - Spring 2026',
        'Part-Time Faculty, Nursing (Fall 2026)',
        'Winter 2026 Ski Instructor',
        'Swim Coach - Summer 2026',
        'Math Tutor - Fall 2026',
        'Substitute Teacher - Spring 2026',
      ]) {
        expect({ title, level: level(title) }).toEqual({ title, level: 'unknown' });
      }
    });

    it('treats a season + year on an associate / staff / assistant / analyst hire as a start date (Q-105)', () => {
      for (const title of [
        'Audit Associate - Fall 2026',
        'Tax Associate - Summer 2026',
        'Assurance Staff - Fall 2026',
        'Audit & Assurance Assistant - Fall 2026',
        'Investment Banking Analyst - Summer 2026',
      ]) {
        const v = classifyCareerLevel({ title });
        expect({ title, level: v.level }).toEqual({ title, level: 'unknown' });
        expect(v.reasons.join(' ')).toMatch(/start date/);
      }
      // An explicit intern word is not a start date.
      expect(level('Audit Intern - Summer 2026')).toBe('internship');
      expect(level('Summer Associate 2026')).toBe('internship');
    });

    it('ignores a season + year in a title that runs an early-career programme', () => {
      expect(level('Internship Coordinator - Summer 2026')).toBe('unknown');
      expect(level('Campus Recruiter - Fall 2026')).toBe('unknown');
    });

    it('an explicit level word always beats a season + year, whatever the level', () => {
      expect(level('Senior Software Engineer (Fall 2026)')).toBe('senior');
      expect(level('Senior Manager, Summer 2026')).toBe('manager');
      expect(level('Director of Marketing - Summer 2026')).toBe('director');
      expect(level('Head Coach - Winter 2026')).toBe('manager');
      expect(level('Software Engineer II - Summer 2026')).toBe('mid');
      expect(level('Junior Developer - Spring 2027')).toBe('entry');
      const v = classifyCareerLevel({ title: 'Senior Software Engineer (Fall 2026)' });
      expect(v.reasons.join(' ')).toMatch(/ignored "fall 2026" \(an explicit level in the title\)/);
    });

    it('a season + year alone still reads as a work term, at LOW confidence (it may be a start date)', () => {
      // Q-105 item 10: ambiguous by construction (new-grad / quant / banking start dates look the
      // same), so it never reaches medium on its own and a consumer can threshold it out.
      for (const title of [
        'Software Engineer - Summer 2026',
        'Software Engineer, Fall 2026',
        'Quantitative Trader - Fall 2026',
        'Fall 2026 Software Engineer',
        'Software Engineer (Winter 2027)',
      ]) {
        const v = classifyCareerLevel({ title });
        expect({ title, level: v.level, confidence: v.confidence }).toEqual({ title, level: 'internship', confidence: 'low' });
        expect(v.reasons[0]).toMatch(/season \+ year only/);
      }
    });

    it('a season + year is lifted to medium only by independent evidence of an internship', () => {
      expect(
        classifyCareerLevel({ title: 'Software Engineer - Summer 2026', description: 'This is a 12-week internship.' }),
      ).toMatchObject({ level: 'internship', confidence: 'medium' });
      expect(
        classifyCareerLevel({ title: 'Software Engineer - Summer 2026', jobType: ['internship'] }),
      ).toMatchObject({ level: 'internship', confidence: 'medium' });
    });

    it('treats "<season> <year> start" as a start date, not a work term', () => {
      expect(level('Software Engineer - Fall 2026 Start')).toBe('unknown');
    });

    it('does not read English "stage" as the French internship', () => {
      expect(level('Stage Manager')).not.toBe('internship');
      expect(level('Stage Hand')).toBe('unknown');
      expect(level('Stage 2 Clinical Trial Associate')).not.toBe('internship');
    });
  });

  describe('new-grad cues', () => {
    table('new_grad', [
      'Software Engineer, New Grad',
      'New Graduate Software Engineer',
      'Newgrad Backend Engineer',
      'NCG - Design Verification Engineer',
      'Recent Graduate - Field Engineer',
      'Software Engineer - University Grad',
      'College Hire - Analyst',
      'Early Career Data Scientist',
      'Early Talent - Engineering',
      'Software Engineer, Early in Career',
      'Class of 2027 Analyst',
      'Fresher - PHP Developer',
      'Graduate Engineer',
      'Graduate Programme - Finance',
      'IT Graduate',
      '2026 Graduate - Operations',
      'Nurse Residency Program',
      'Rotational Program Analyst',
    ]);

    it('an explicit new-grad cue beats a season + year', () => {
      expect(level('Software Engineer, New Grad (Fall 2026)')).toBe('new_grad');
    });

    it('does not treat post-graduate or institutional "graduate" as a role', () => {
      expect(level('Post-Graduate Research Fellow')).not.toBe('new_grad');
      expect(level('Graduate Admissions Counselor')).toBe('unknown');
      expect(level('Graduate School Administrator')).toBe('unknown');
      expect(level('Graduate Medical Education Coordinator')).toBe('unknown');
    });

    it('a graduate-student appointment is an internship, never new_grad (Q-105)', () => {
      expect(level('Graduate Research Assistant - Chemistry')).toBe('internship');
      expect(level('Graduate Assistant')).toBe('internship');
    });
  });

  describe('program-admin context (the cue names the programme, not the role)', () => {
    it.each<[string, CareerLevel]>([
      // (a) admin noun right after the cue
      ['Intern Program Manager', 'unknown'],
      ['Senior Intern Program Manager', 'senior'],
      ['Internship Coordinator', 'unknown'],
      ['Early Careers Recruiter', 'unknown'],
      ['New Grad Hiring Manager', 'manager'],
      ['Graduate Program Coordinator', 'unknown'],
      ['Co-op Coordinator', 'unknown'],
      ['Apprenticeship Program Manager', 'unknown'],
      // (b) of / for + leadership noun
      ['Head of Early Careers', 'director'],
      ['Director of University Programs', 'director'],
      // (c) plural cue + admin noun
      ['Director, Internships', 'director'],
      ['Recruiter, Early Careers', 'unknown'],
      // (e) programme noun + admin noun
      ['Director, Intern Programs', 'director'],
      ['Coordinator, Co-op Programs', 'unknown'],
      // (d) recruiting / programme-staff head in another segment
      ['Campus Recruiter - New Grad', 'unknown'],
      ['Nurse Educator - New Graduate Residency', 'unknown'],
    ])('%s → %s', (title, expected) => {
      expect(level(title)).toBe(expected);
    });

    it.each<[string, CareerLevel]>([
      ['Program Manager Intern', 'internship'],
      ['Product Manager Intern', 'internship'],
      ['Talent Acquisition Intern', 'internship'],
      ['Recruiting Intern', 'internship'],
      ['Marketing Coordinator Intern', 'internship'],
      ['Graduate Product Manager', 'new_grad'],
      ['Interns - Summer 2026 Engineering Program', 'internship'],
      ['Graduate Program - Finance', 'new_grad'],
    ])('keeps the role reading: %s → %s', (title, expected) => {
      expect(level(title)).toBe(expected);
    });

    it('explains an ignored cue in the reasons', () => {
      const v = classifyCareerLevel({ title: 'Internship Coordinator' });
      expect(v.reasons.join(' ')).toMatch(/ignored "internship" \(program\/recruiting context\)/);
    });
  });

  describe('executive / director / manager', () => {
    table('executive', [
      'VP of Engineering',
      'Vice-President, Marketing',
      'SVP Sales',
      'Chief Technology Officer',
      'CTO',
      'President',
      'Managing Director',
      'Executive Director',
      'Managing Partner',
      'Partner',
      'Co-Founder',
    ]);
    table('director', [
      'Director of Product',
      'Senior Director, Engineering',
      'Associate Director, Biostatistics',
      'Head of Growth',
      'Chief of Staff',
      'Chief of Staff to the CEO',
      'School Principal',
      'Vice Principal',
    ]);
    table('manager', [
      'Engineering Manager',
      'Senior Manager, Finance',
      'Manager II',
      'Store Manager',
      'Group Product Manager',
      'Shift Supervisor',
      'Team Lead - Support',
      'Head Chef',
      'Executive Chef',
      'Internal Audit Manager',
    ]);

    it('a bank corporate VP title on an IC role is senior, not executive (Q-105)', () => {
      expect(level('Vice President, Software Engineer')).toBe('senior');
      expect(level('Data Analyst - AVP')).toBe('senior');
      expect(level('Vice President of Software Engineering')).toBe('executive');
    });

    it('someone else is the executive in "… to the CEO" / "Assistant to the President"', () => {
      expect(level('Executive Assistant to the CEO')).toBe('unknown');
      expect(level('Assistant to the President')).toBe('unknown');
    });

    it('someone else is the VP / founder / director / head / managing director / partner (spec §7.5 row 3)', () => {
      for (const title of [
        'Executive Assistant to the VP of Sales',
        'Executive Assistant to the Vice President',
        'Executive Assistant to the SVP, Operations',
        'Executive Assistant to the Founder',
        'Business Associate, Office of the Founders',
        'Executive Assistant to the Managing Director',
        'Assistant to the Managing Partner',
        'Assistant to the Director',
        'Administrative Assistant to the Head of School',
        'Executive Assistant for the Director of Operations',
      ]) {
        expect({ title, level: level(title) }).toEqual({ title, level: 'unknown' });
      }
      // Controls: the role itself is the VP / founder / director / head.
      expect(level('VP of Sales')).toBe('executive');
      expect(level('Founder & CEO')).toBe('executive');
      expect(level('Assistant Director of Admissions')).toBe('director');
      expect(level('Head of School')).toBe('director');
    });

    it('someone else is the manager: "to / for (the) <modifiers> manager"', () => {
      expect(level('Executive Assistant to the General Manager')).toBe('unknown');
      expect(level('Recruiter for Store Managers')).toBe('unknown');
      expect(level('Management Trainee - Path to General Manager')).toBe('entry');
      expect(level('Assistant to the Regional Director')).toBe('unknown');
    });

    it('a bare "of" inside a compound noun is not a holder ("Front of House Manager")', () => {
      expect(level('Front of House Manager')).toBe('manager');
      expect(level('Back of House Supervisor')).toBe('manager');
      expect(level('Board of Directors')).toBe('unknown');
      const v = classifyCareerLevel({ title: 'Assistant to the Director' });
      expect(v.reasons.join(' ')).toMatch(/ignored "director" \(someone else's title\)/);
    });

    it("a founder's office / founders' programme is a function, not a founder role", () => {
      expect(level("Founder's Associate")).toBe('unknown');
      expect(level('Founders Office Associate')).toBe('unknown');
      expect(level("Founder's Office - Business Operations")).toBe('unknown');
      expect(level('Founders Fund Analyst')).toBe('unknown');
      expect(level('Co-Founder')).toBe('executive');
      expect(level('Founder')).toBe('executive');
    });

    it('does not treat IC "manager" titles, business partners or sales executives as management', () => {
      for (const title of [
        'Product Manager',
        'Program Manager',
        'Technical Program Manager',
        'Project Manager',
        'Account Manager',
        'Customer Success Manager',
        'Product Marketing Manager',
        'HR Business Partner',
        'Partner Engineer',
        'Account Executive',
        'Executive Assistant',
        'Funeral Director',
        'Partner Marketing Manager',
      ]) {
        expect(level(title)).toBe('unknown');
      }
    });

    it('"senior partner" is a partnership rank only when partner is the head noun', () => {
      for (const title of [
        'Senior Partner Manager',
        'Senior Partner Solutions Architect',
        'Senior Partner Engineer, Google Cloud',
        'Senior Partner Account Manager',
      ]) {
        const v = classifyCareerLevel({ title });
        expect({ title, level: v.level }).toEqual({ title, level: 'senior' });
        expect(v.reasons.some((r) => /ignored "senior partners?" \(partner modifies/.test(r))).toBe(true);
      }
      for (const title of [
        'Senior Partner',
        'Senior Partner - Audit',
        'Senior Partner (Tax)',
        'Senior Partner at Acme Law',
        'Senior Partner of the Firm',
        'Senior Partner & Head of Tax',
        'Managing Partner and CEO',
        'Equity Partner',
      ]) {
        expect({ title, level: level(title) }).toEqual({ title, level: 'executive' });
      }
    });
  });

  describe('IC ladder', () => {
    table('principal', ['Principal Engineer', 'Senior Principal Scientist', 'Distinguished Engineer', 'Technical Fellow', 'Principal Investigator']);
    table('staff', ['Staff Software Engineer', 'Senior Staff Engineer', 'Staff Product Designer', 'Staff Technical Program Manager']);
    table('senior', ['Senior Software Engineer', 'Sr. Analyst', 'Snr Developer', 'Lead Engineer', 'Technical Lead', 'Senior Member of Technical Staff']);
    table('mid', ['Mid-Level Developer', 'Midlevel Engineer', 'Intermediate Developer', 'Journeyman Electrician']);
    table('entry', [
      'Junior Developer',
      'Jr. Analyst',
      'Entry Level Technician',
      'Associate Engineer',
      'Associate Product Manager',
      'Staff Accountant',
      'Apprentice Carpenter',
      'Management Trainee',
      'Postdoctoral Researcher',
    ]);

    it('ignores staff / senior / junior / lead / associate / mid false friends', () => {
      expect(level('Staff Nurse')).toBe('unknown');
      expect(level('Staff Pharmacist')).toBe('unknown');
      expect(level('Member of Technical Staff')).toBe('unknown');
      expect(level('Senior Living Community Specialist')).toBe('unknown');
      expect(level('Senior Care Aide')).toBe('unknown');
      expect(level('Senior High School Teacher')).toBe('unknown');
      expect(level('Junior High Teacher')).toBe('unknown');
      expect(level('Lead Generation Specialist')).toBe('unknown');
      expect(level('Lead Abatement Worker')).toBe('unknown');
      expect(level('Associate Professor of Biology')).toBe('unknown');
      expect(level('Warehouse Associate')).toBe('unknown');
      expect(level('Mid-Market Account Executive')).toBe('unknown');
      expect(level('Intermediate School Teacher')).toBe('unknown');
    });

    it('associate director / principal / partner are not entry', () => {
      expect(level('Associate Director')).toBe('director');
      expect(level('Associate Principal Engineer')).toBe('principal');
    });

    it('stacked modifiers take the higher rung; separated ones are a range (lower bound, low)', () => {
      expect(level('Senior Staff Engineer')).toBe('staff');
      expect(level('Senior Principal Engineer')).toBe('principal');
      const junMid = classifyCareerLevel({ title: 'Junior/Mid Developer' });
      expect(junMid.level).toBe('entry');
      expect(junMid.confidence).toBe('low');
      const midSen = classifyCareerLevel({ title: 'Mid-Senior Data Scientist' });
      expect(midSen.level).toBe('mid');
      expect(midSen.confidence).toBe('low');
      expect(level('Senior/Staff Software Engineer')).toBe('senior');
    });
  });

  describe('level numerals (Q-105: I → entry, II → mid, III → senior/low, IV+ → senior)', () => {
    it.each<[string, CareerLevel]>([
      ['Software Engineer I', 'entry'],
      ['Engineer 1', 'entry'],
      ['SDE II', 'mid'],
      ['Analyst 2', 'mid'],
      ['Nurse II - Pediatrics', 'mid'],
      ['Engineer - II', 'mid'],
      ['Level 2 Network Engineer', 'mid'],
      ['Software Engineer III', 'senior'],
      ['Engineer IV', 'senior'],
      ['Specialist V', 'senior'],
    ])('%s → %s', (title, expected) => {
      expect(level(title)).toBe(expected);
    });

    it('confidence: II is medium, III is low', () => {
      expect(classifyCareerLevel({ title: 'Engineer II' }).confidence).toBe('medium');
      expect(classifyCareerLevel({ title: 'Engineer III' }).confidence).toBe('low');
    });

    it('a numeral range resolves to the lower bound with low confidence', () => {
      const v = classifyCareerLevel({ title: 'Software Engineer I/II' });
      expect(v.level).toBe('entry');
      expect(v.confidence).toBe('low');
      expect(level('Analyst II or III')).toBe('mid');
    });

    it('ignores support tiers, gender markers and numbers that are not levels', () => {
      expect(level('Tier 2 Support Technician')).toBe('unknown');
      expect(level('Level 1 Support Analyst')).toBe('unknown');
      expect(level('Software Engineer (m/v)')).toBe('unknown');
      expect(level('Ontwikkelaar (v/m)')).toBe('unknown');
      expect(level('Class 1 Driver')).toBe('unknown');
      expect(level('Engineer, 3D Graphics')).toBe('unknown');
      expect(level('Grade 5 Teacher')).toBe('unknown');
    });

    it('an explicit keyword beats a numeral', () => {
      expect(level('Senior Engineer II')).toBe('senior');
      expect(level('Software Engineer I - New Grad')).toBe('new_grad');
    });
  });

  describe('structured source fields', () => {
    it('jobType internship decides when the title is silent', () => {
      const v = classifyCareerLevel({ title: 'Software Engineer', jobType: ['fulltime', 'internship'] });
      expect(v).toMatchObject({ level: 'internship', confidence: 'medium' });
      expect(v.reasons).toContain('jobType: internship');
    });

    it('employmentType / jobLevel / experienceRange decide when the title is silent', () => {
      expect(level('Software Engineer', { employmentType: 'Internship' })).toBe('internship');
      expect(level('Software Engineer', { jobLevel: 'Entry level' })).toBe('entry');
      expect(level('Software Engineer', { jobLevel: 'Mid-Senior level' })).toBe('mid');
      expect(level('Software Engineer', { jobLevel: 'Executive' })).toBe('executive');
      expect(level('Software Engineer', { jobLevel: 'Not Applicable' })).toBe('unknown');
      expect(level('Java Developer', { experienceRange: '0-2 Yrs' })).toBe('entry');
      expect(level('Java Developer', { experienceRange: '3-5 Yrs' })).toBe('mid');
      expect(level('Java Developer', { experienceRange: '8-12 Years' })).toBe('senior');
      expect(level('Java Developer', { experienceRange: 'Fresher' })).toBe('new_grad');
    });

    it('an agreeing structured field raises confidence; the title still decides', () => {
      expect(classifyCareerLevel({ title: 'Engineer II' }).confidence).toBe('medium');
      const v = classifyCareerLevel({ title: 'Engineer II', jobLevel: 'Mid level' });
      expect(v).toMatchObject({ level: 'mid', confidence: 'high' });
      expect(v.reasons.some((r) => r.startsWith('corroborated by'))).toBe(true);
    });

    it('a conflicting structured field lowers confidence but does not override the title', () => {
      const v = classifyCareerLevel({ title: 'Senior Software Engineer', experienceRange: '0-1 Yrs' });
      expect(v).toMatchObject({ level: 'senior', confidence: 'medium' });
      expect(v.reasons.some((r) => r.startsWith('conflict:'))).toBe(true);
    });

    it('never mutates the source fields', () => {
      const input = {
        title: 'Software Engineer',
        jobType: ['internship'],
        jobLevel: 'Internship',
        experienceRange: '0-1 Yrs',
        description: 'This is a 10-week internship.',
      };
      const snapshot = JSON.stringify(input);
      classifyCareerLevel(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });

  describe('description (secondary, low confidence)', () => {
    it.each<[string, CareerLevel]>([
      ['This is a 12-week paid summer internship on the platform team.', 'internship'],
      ['As a software engineering intern, you will build tools.', 'internship'],
      ['This role is designed for recent graduates.', 'new_grad'],
      ['Open to the Class of 2026.', 'new_grad'],
      ['This is an entry-level position with full training.', 'entry'],
      ['No prior experience required.', 'entry'],
      ['You will manage a team of 6 engineers.', 'manager'],
      ['Requirements: 5+ years of professional experience with Java.', 'senior'],
      ['At least two years of relevant work experience.', 'mid'],
      ["3-5 years' experience in data engineering.", 'mid'],
      ['Experience: 0-1 years', 'entry'],
    ])('%s → %s', (description, expected) => {
      const v = classifyCareerLevel({ title: 'Engineer', description });
      expect(v.level).toBe(expected);
      expect(v.confidence).toBe('low');
    });

    it('ignores incidental mentions', () => {
      for (const description of [
        'Our internship program is one of the best; ask your recruiter.',
        'You will mentor junior engineers and new grads.',
        'We hire everyone from interns to principal engineers.',
        'This role is not an internship.',
        'Founded in 1999, we have 25 years of experience serving customers.',
        'Bachelor degree (4 year degree) preferred.',
      ]) {
        expect(classifyCareerLevel({ title: 'Engineer', description }).level).toBe('unknown');
      }
    });

    it('uses the largest lower bound across experience mentions', () => {
      expect(
        level('Engineer', {
          description: '5+ years of experience building services. 2+ years of experience with Kubernetes.',
        }),
      ).toBe('senior');
    });

    it('strips HTML and only reads the first 3,000 characters', () => {
      expect(level('Engineer', { description: '<p>This is a <b>10-week</b> internship.</p>' })).toBe('internship');
      const late = `${'Lorem ipsum dolor sit amet. '.repeat(200)} This is a 10-week internship.`;
      expect(late.length).toBeGreaterThan(3000);
      expect(level('Engineer', { description: late })).toBe('unknown');
    });

    /** Markup with no visible text: inline-styled wrappers as ATS pages emit them. */
    const noise = (bytes: number): string => {
      const tag = '<div style="margin:0;padding:0;font-family:Arial,sans-serif;color:#333"><span class="x">';
      return tag.repeat(Math.ceil(bytes / tag.length));
    };
    const entry = '<p>This is an entry-level role. 0-1 years of experience required.</p>';

    it('reads the first 3,000 VISIBLE characters of tag-heavy HTML, not the first 4,500 raw ones', () => {
      expect(level('Engineer', { description: `${entry}${noise(5_000)}` })).toBe('entry');
      expect(level('Engineer', { description: `${noise(5_000)}${entry}` })).toBe('entry');
      expect(level('Engineer', { description: `${noise(40_000)}${entry}` })).toBe('entry');
    });

    it('bounds the raw scan: visible text past MAX_DESCRIPTION_SCAN_CHARS is not read', () => {
      expect(level('Engineer', { description: `${noise(MAX_DESCRIPTION_SCAN_CHARS + 1_000)}${entry}` })).toBe('unknown');
    });

    it('a scan window that ends inside a tag never leaks the tag text as description', () => {
      const leaky = `<img alt="This is a 10-week internship." data-tracking="${'t'.repeat(120)}">`;
      // Whole tags up to just short of the first raw window (4,500 characters), so the next tag
      // straddles the window edge and a naive cut leaves it open.
      let filler = noise(4_400);
      while (filler.length > 4_400) filler = filler.slice(0, filler.lastIndexOf('<div'));
      while (filler.length + 4 <= 4_440) filler += '<br>';
      // The cue itself ends before the window edge; only the tag's closing ">" lies beyond it.
      expect(filler.length + leaky.indexOf('internship.') + 11).toBeLessThan(4_500);
      const description = `${filler}${leaky}<p>Great team.</p>`;
      expect(filler.length).toBeLessThan(4_500);
      expect(filler.length + leaky.length).toBeGreaterThan(4_500);
      expect(level('Engineer', { description })).toBe('unknown');
    });

    it('keeps a plain-text "<" (less-than), which is not a tag', () => {
      expect(level('Engineer', { description: `Experience: 0-1 years (< 2). ${'Lorem ipsum. '.repeat(400)}` })).toBe('entry');
    });

    it('the single-pass needle scan is exact: no needle occurs inside another except as a prefix', () => {
      for (const a of DESCRIPTION_NEEDLES) {
        for (const b of DESCRIPTION_NEEDLES) {
          if (a === b) continue;
          const at = b.indexOf(a);
          expect({ inner: a, outer: b, at: at > 0 ? at : -1 }).toEqual({ inner: a, outer: b, at: -1 });
        }
      }
    });

    it('finds overlapping cues in one description', () => {
      const v = classifyCareerLevel({
        title: 'Engineer',
        description: 'As an intern, you will join us. This 12-week internship starts in June.',
      });
      expect(v.level).toBe('internship');
    });

    it('title beats the description', () => {
      expect(level('Staff Engineer', { description: 'This is a 12-week internship.' })).toBe('staff');
    });
  });

  describe('verdict shape and robustness', () => {
    it('always returns a known level, a confidence and 1..5 reasons', () => {
      const inputs: Array<CareerLevelInput | null | undefined> = [
        null,
        undefined,
        {},
        { title: '' },
        { title: '   ' },
        { title: '!!!' },
        { title: 'Senior Software Engineer' },
        { title: 42 as unknown as string, description: {} as unknown as string, jobType: 'x' as unknown as string[] },
        { title: 'x'.repeat(5000), description: 'y'.repeat(100_000) },
        { title: '👩‍💻 Ingénieure Logiciel Senior' },
      ];
      for (const input of inputs) {
        const v = classifyCareerLevel(input);
        expect(CAREER_LEVELS).toContain(v.level);
        expect(['high', 'medium', 'low']).toContain(v.confidence);
        expect(v.reasons.length).toBeGreaterThan(0);
        expect(v.reasons.length).toBeLessThanOrEqual(MAX_REASONS);
        for (const r of v.reasons) expect(typeof r).toBe('string');
      }
    });

    it('reads only the first ~300 title characters, cut at a word boundary', () => {
      // Without a word-boundary cut the tail would end in "... manager i" and read as numeral I.
      expect(level('intern program manager '.repeat(40))).toBe('unknown');
      expect(level(`${'x '.repeat(200)}Senior Engineer`)).toBe('unknown');
    });

    it('caps employmentType / jobLevel like the title and experienceRange at MAX_FIELD_CHARS', () => {
      const pad = 'x '.repeat(MAX_TITLE_CHARS);
      // The start of an over-long field still counts; a cue past the cap does not.
      expect(level('Software Engineer', { employmentType: `Internship ${pad}` })).toBe('internship');
      expect(level('Software Engineer', { employmentType: `${pad}Internship` })).toBe('unknown');
      expect(level('Software Engineer', { jobLevel: `Senior ${pad}` })).toBe('senior');
      expect(level('Software Engineer', { jobLevel: `${pad}Senior` })).toBe('unknown');
      expect(level('Java Developer', { experienceRange: `3-5 Yrs ${pad}` })).toBe('mid');
      expect(level('Java Developer', { experienceRange: `${'x '.repeat(MAX_FIELD_CHARS)}3-5 Yrs` })).toBe('unknown');
    });

    it('quotes at most ~60 characters of a source field in a reason', () => {
      const v = classifyCareerLevel({ title: 'Java Developer', experienceRange: `3-5 Yrs ${'relevant '.repeat(12)}` });
      expect(v.level).toBe('mid');
      const reason = v.reasons.find((r) => r.startsWith('experienceRange:'))!;
      expect(reason).toMatch(/^experienceRange: "3-5 Yrs relevant .*…" \(3\+ years\)$/);
      expect(reason.length).toBeLessThan(100);
    });

    it('capAtWord cuts at a word boundary and never exceeds the limit', () => {
      expect(capAtWord('short', 10)).toBe('short');
      expect(capAtWord('manager ii', 9)).toBe('manager');
      expect(capAtWord('manager ii', 10)).toBe('manager ii');
      expect(capAtWord('senior engineer ', 15)).toBe('senior engineer');
      expect(capAtWord('a'.repeat(50), 10)).toBe('a'.repeat(10));
      for (const s of ['intern program manager '.repeat(40), 'x'.repeat(1000), ' '.repeat(500)]) {
        expect(capAtWord(s, MAX_TITLE_CHARS).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      }
    });

    it('unknown is low confidence and says so', () => {
      const v = classifyCareerLevel({ title: 'Barista' });
      expect(v).toMatchObject({ level: 'unknown', confidence: 'low' });
      expect(v.reasons[0]).toMatch(/no seniority signal/);
    });

    it('an explicit title keyword is high confidence', () => {
      expect(classifyCareerLevel({ title: 'Software Engineer Intern' }).confidence).toBe('high');
      expect(classifyCareerLevel({ title: 'Senior Software Engineer' }).confidence).toBe('high');
    });

    it('is deterministic', () => {
      const input = { title: 'Senior Intern Program Manager', description: '5+ years of experience' };
      expect(classifyCareerLevel(input)).toEqual(classifyCareerLevel(input));
    });

    it('handles accents and case', () => {
      expect(normalizeCareerText('  ESTAGIÁRIO   de  Engenharia ')).toBe('estagiario de engenharia');
      expect(level('Ingénieure Logiciel Senior')).toBe('senior');
    });
  });
});
