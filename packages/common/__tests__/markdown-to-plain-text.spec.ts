import { markdownToPlainText } from '../src/utils/html-utils';

/** PR #100 review — Markdown sources asked for plain text keep none of their markers. */
describe('markdownToPlainText', () => {
  it('drops heading, emphasis, code and quote markers; keeps link and image text', () => {
    const md = [
      '## About the role',
      '',
      'We need **humanitarian data** skills and _field_ experience with `pandas`.',
      '',
      '> Apply by 30 September.',
      '',
      'See [the terms](https://reliefweb.int/terms) and ![the logo](https://x.test/l.png).',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      [
        'About the role',
        '',
        'We need humanitarian data skills and field experience with pandas.',
        '',
        'Apply by 30 September.',
        '',
        'See the terms and the logo.',
      ].join('\n'),
    );
  });

  it('keeps list items as "- " bullets and drops horizontal rules', () => {
    expect(markdownToPlainText('* one\n+ two\n- three\n\n---\n\nend')).toBe('- one\n- two\n- three\n\nend');
  });

  it('leaves word-internal underscores and asterisks alone', () => {
    expect(markdownToPlainText('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4');
  });

  it('converts HTML embedded in the Markdown', () => {
    expect(markdownToPlainText('**Role**<br>Lead <b>partnerships</b>.')).toBe('Role\nLead partnerships.');
  });
});
