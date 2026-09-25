import type { CareerLevel, CareerLevelInput } from '@ever-jobs/models';
import { CAREER_LEVELS } from '@ever-jobs/models';

import {
  classifyCareerLevel,
  DESCRIPTION_NEEDLES,
  MAX_REASONS,
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

    it('treats a seasonal job with a season + year as seasonal, not an internship', () => {
      expect(level('Lifeguard - Summer 2026')).toBe('unknown');
      expect(level('Summer Camp Counselor 2026')).toBe('unknown');
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
      ]) {
        expect(level(title)).toBe('unknown');
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
