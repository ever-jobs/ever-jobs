import {
  MARKDOWN_EDGE_SAFE_ENV,
  markdownConverter,
  wrapInlineEmphasis,
} from '../src/converters/description-converter';

// Spec 1698 — Markdown emphasis and line-break fidelity. All inputs are
// synthetic, shaped after the rich-text HTML job descriptions commonly carry.

// Every case runs against the default rules, whatever the shell exports; the
// suite that tests the switch sets it itself.
const shellEdgeSafe = process.env[MARKDOWN_EDGE_SAFE_ENV];
beforeEach(() => {
  delete process.env[MARKDOWN_EDGE_SAFE_ENV];
});
afterAll(() => {
  if (shellEdgeSafe === undefined) delete process.env[MARKDOWN_EDGE_SAFE_ENV];
  else process.env[MARKDOWN_EDGE_SAFE_ENV] = shellEdgeSafe;
});

describe('markdownConverter — emphasis edges (Spec 1698)', () => {
  it('keeps a blank line between a bold label and the list that follows it (lock-in)', () => {
    // Already correct before Spec 1698: a list is a block, so turndown puts a
    // blank line before it. Locked in so the new rules cannot regress it.
    expect(markdownConverter('<strong>Requirements:</strong><ul><li>TypeScript</li><li>Node</li></ul>')).toBe(
      '**Requirements:**\n\n*   TypeScript\n*   Node',
    );
    expect(markdownConverter('<p><b>Benefits</b></p><ol><li>Health</li><li>Dental</li></ol>')).toBe(
      '**Benefits**\n\n1.  Health\n2.  Dental',
    );
  });

  it('moves trailing <br><br> out of a bold label before a list', () => {
    expect(
      markdownConverter('<strong>OUR HIRING PROCESS:<br/><br/></strong><ul><li>We will review your application</li></ul>'),
    ).toBe('**OUR HIRING PROCESS:**\n\n*   We will review your application');
    expect(
      markdownConverter('<p><strong>You will be a fit if you have:<br></strong></p><ul><li>5+ years of Go</li></ul>'),
    ).toBe('**You will be a fit if you have:**\n\n*   5+ years of Go');
  });

  it('keeps a single trailing break as a hard break after the closing delimiter', () => {
    expect(markdownConverter('<strong>Title<br></strong>text')).toBe('**Title**  \ntext');
    expect(markdownConverter('<strong><span>Wrapped<br></span></strong>next')).toBe('**Wrapped**  \nnext');
  });

  it('moves a leading break in front of the opening delimiter', () => {
    expect(markdownConverter('<b><br>Title</b>')).toBe('**Title**');
    expect(markdownConverter('text<b><br>Title</b>')).toBe('text  \n**Title**');
    expect(markdownConverter('<p><strong><br/>About the company</strong></p><p>We build reactors.</p>')).toBe(
      '**About the company**\n\nWe build reactors.',
    );
  });

  it('applies the same rule to em/i', () => {
    expect(markdownConverter('<em>Note:<br><br></em>')).toBe('_Note:_');
    expect(markdownConverter('<i><br><br>Italic lead</i>')).toBe('_Italic lead_');
    expect(markdownConverter('<em>Hybrid<br></em>3 days on site')).toBe('_Hybrid_  \n3 days on site');
  });

  it('closes nested emphasis on the same line', () => {
    expect(markdownConverter('<strong><em>Nested:<br></em></strong><ul><li>x</li></ul>')).toBe('**_Nested:_**\n\n*   x');
  });

  it('wraps each paragraph separately when emphasis spans a blank line', () => {
    expect(markdownConverter('<strong>A<br><br>B</strong>')).toBe('**A**\n\n**B**');
    expect(markdownConverter('<b><p>First</p><p>Second</p></b>')).toBe('**First**\n\n**Second**');
  });

  it('keeps an interior single break inside the delimiters', () => {
    expect(markdownConverter('<strong>Line1<br>Line2</strong>')).toBe('**Line1  \nLine2**');
  });

  it('keeps the line break of an emphasis element that holds only <br>', () => {
    expect(markdownConverter('<p>a<strong><br/></strong>b</p>')).toBe('a  \nb');
    expect(markdownConverter('<strong><br></strong>')).toBe('');
  });

  it('drops the delimiters instead of wrapping a list', () => {
    expect(markdownConverter('<strong><ul><li>x</li></ul></strong>')).toBe('*   x');
    expect(markdownConverter('<em><blockquote>Quoted</blockquote></em>')).toBe('> Quoted');
  });

  it('treats zero-width filler lines as blank', () => {
    expect(markdownConverter('<strong>Inquiries<br/>&#x200D;<br/></strong>Contact us')).toBe(
      '**Inquiries**\n\nContact us',
    );
    expect(markdownConverter('<p>&#x200D;</p><p><strong>Benefits</strong></p>')).toBe('**Benefits**');
  });

  it('splits emphasis at a zero-width filler line between two paragraphs', () => {
    // The tidy pass turns the filler line into a blank line, so the emphasis
    // must already be closed before it.
    expect(markdownConverter('<strong>A<br>&#x200B;<br>B</strong>')).toBe('**A**\n\n**B**');
  });
});

describe('markdownConverter — headings (Spec 1698)', () => {
  it('drops a trailing break so the heading stays one line', () => {
    expect(markdownConverter('<h2>Title<br></h2><p>Stuff</p>')).toBe('Title\n-----\n\nStuff');
    expect(markdownConverter('<h2><strong>What you will do<br></strong></h2><p>Stuff</p>')).toBe(
      '**What you will do**\n--------------------\n\nStuff',
    );
    expect(markdownConverter('<h3><strong>Benefits<br></strong></h3><p>Stuff</p>')).toBe('### **Benefits**\n\nStuff');
  });

  it('folds an interior break into a single space', () => {
    expect(markdownConverter('<h3>Title<br>Sub</h3>')).toBe('### Title Sub');
    expect(markdownConverter('<h1>Title<br><br>Sub</h1>')).toBe('Title Sub\n=========');
    expect(markdownConverter('<h4><p>Part one</p><p>Part two</p></h4>')).toBe('#### Part one Part two');
  });

  it('keeps an ordinary heading as before', () => {
    expect(markdownConverter('<h1>Senior Engineer</h1>')).toBe('Senior Engineer\n===============');
    expect(markdownConverter('<h5>Perks</h5>')).toBe('##### Perks');
  });

  it('emits nothing for a heading that holds only a break', () => {
    expect(markdownConverter('<p>Before</p><h2><br></h2><p>After</p>')).toBe('Before\n\nAfter');
  });
});

describe('markdownConverter — whitespace tidy (Spec 1698)', () => {
  it('collapses runs of <br> into one paragraph break', () => {
    expect(markdownConverter('<div>A<br><br><br><br>B</div>')).toBe('A\n\nB');
    expect(markdownConverter('<p><strong>About us</strong><br><br>We build things.</p>')).toBe(
      '**About us**\n\nWe build things.',
    );
  });

  it('drops spacer <div><br></div> lines between sections', () => {
    expect(markdownConverter('<div>and more.</div><div><br></div><div><br></div><div><b>The Role</b></div>')).toBe(
      'and more.\n\n**The Role**',
    );
  });

  it('leaves preformatted blocks untouched', () => {
    const html = '<p>Intro</p><pre><code>line1\n\n\n\nline2</code></pre>';
    expect(markdownConverter(html)).toBe('Intro\n\n    line1\n    \n    \n    \n    line2');
  });

  it('does not change output that was already correct', () => {
    expect(markdownConverter('<p>Hello <b>world</b></p>')).toBe('Hello **world**');
    // The non-breaking space is kept, exactly as before.
    expect(markdownConverter('<p><strong>Salary:&nbsp;</strong>$100k</p>')).toBe('**Salary:**\u00A0$100k');
    expect(markdownConverter('<p><strong>Location:</strong> Remote<br><strong>Type:</strong> Full-time</p>')).toBe(
      '**Location:** Remote  \n**Type:** Full-time',
    );
    expect(markdownConverter('<div>Company <strong>intro</strong></div><h2>Role</h2>')).toBe(
      'Company **intro**\n\nRole\n----',
    );
    expect(markdownConverter('<p>5 * 3 = 15 and a_b_c</p>')).toBe('5 \\* 3 = 15 and a\\_b\\_c');
  });

  it('returns null for empty input', () => {
    expect(markdownConverter(null)).toBeNull();
    expect(markdownConverter('')).toBeNull();
  });
});

describe('markdownConverter — previous behaviour stays reachable (Spec 1698)', () => {
  const html = '<strong>OUR HIRING PROCESS:<br/><br/></strong><ul><li>We will review your application</li></ul>';
  const previous = '**OUR HIRING PROCESS:  \n  \n**\n\n*   We will review your application';
  const fixed = '**OUR HIRING PROCESS:**\n\n*   We will review your application';
  const saved = process.env[MARKDOWN_EDGE_SAFE_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[MARKDOWN_EDGE_SAFE_ENV];
    else process.env[MARKDOWN_EDGE_SAFE_ENV] = saved;
  });

  it('names the environment switch', () => {
    expect(MARKDOWN_EDGE_SAFE_ENV).toBe('EVER_JOBS_MARKDOWN_EDGE_SAFE');
  });

  it('returns the previous output when edgeSafe is false', () => {
    expect(markdownConverter(html, { edgeSafe: false })).toBe(previous);
    expect(markdownConverter('<div>A<br><br><br><br>B</div>', { edgeSafe: false })).toBe('A  \n  \n  \n  \nB');
    expect(markdownConverter('<h3>Title<br>Sub</h3>', { edgeSafe: false })).toBe('### Title  \nSub');
  });

  it.each(['false', '0', 'no', 'off', ' OFF '])('returns the previous output when the env switch is %p', (value) => {
    process.env[MARKDOWN_EDGE_SAFE_ENV] = value;
    expect(markdownConverter(html)).toBe(previous);
  });

  it.each(['true', '1', 'yes', ''])('keeps the fix on when the env switch is %p', (value) => {
    process.env[MARKDOWN_EDGE_SAFE_ENV] = value;
    expect(markdownConverter(html)).toBe(fixed);
  });

  it('lets a per-call option override the env switch', () => {
    process.env[MARKDOWN_EDGE_SAFE_ENV] = 'false';
    expect(markdownConverter(html, { edgeSafe: true })).toBe(fixed);
  });

  it('returns null for empty input either way', () => {
    expect(markdownConverter(null, { edgeSafe: false })).toBeNull();
    expect(markdownConverter('', { edgeSafe: false })).toBeNull();
  });
});

describe('wrapInlineEmphasis (Spec 1698)', () => {
  it('moves edge padding outside the delimiter', () => {
    expect(wrapInlineEmphasis('  \nTitle  \n', '**')).toBe('  \n**Title**  \n');
    expect(wrapInlineEmphasis('\u200DTitle\uFEFF', '_')).toBe('\u200D_Title_\uFEFF');
  });

  it('wraps each paragraph on its own', () => {
    expect(wrapInlineEmphasis('A  \n  \nB', '**')).toBe('**A**  \n  \n**B**');
  });

  it('stays linear on a long padding run in the middle of the text', () => {
    // An unanchored trailing-padding regex is quadratic here (~2 s at 40k
    // characters, minutes at 200k); the backward scan takes milliseconds.
    const run = '\u00A0'.repeat(200_000);
    const started = Date.now();
    expect(wrapInlineEmphasis(`a${run}b${run}`, '**')).toBe(`**a${run}b**${run}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('returns only the break when there is no text', () => {
    expect(wrapInlineEmphasis('  \n', '**')).toBe('  \n');
    expect(wrapInlineEmphasis('   ', '**')).toBe('');
    expect(wrapInlineEmphasis('', '**')).toBe('');
  });
});
