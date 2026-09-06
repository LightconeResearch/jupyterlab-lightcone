import { findQuoteMatch, highlightMatch } from '../pdf-quote';

describe('PDF quote matching', () => {
  it('matches split text runs, ligatures, hyphenation, and smart quotes', () => {
    const match = findQuoteMatch(
      ['The “ofﬁce” repro-', 'ducibility result.'],
      'The "office" reproducibility result.'
    );
    expect(match).toMatchObject({ complete: true });
  });

  it('distinguishes a partial match from an exact quote', () => {
    expect(
      findQuoteMatch(
        ['A reproducible result appears'],
        'A reproducible result appears on another page.'
      )
    ).toMatchObject({ complete: false });
    expect(
      findQuoteMatch(['Unrelated content'], 'A reproducible result')
    ).toBeUndefined();
  });

  it('highlights original character ranges without treating quoted text as HTML', () => {
    const strings = ['Prefix <script>quoted</script> suffix'];
    const divs = [document.createElement('span')];
    const mark = highlightMatch(strings, divs, '<script>quoted</script>');
    expect(mark?.textContent).toBe('<script>quoted</script>');
    expect(divs[0].querySelector('script')).toBeNull();
    expect(divs[0].textContent).toBe(strings[0]);
  });
});
