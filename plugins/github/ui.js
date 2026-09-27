// github — the "GitHub" section of the card detail: every PR of the card, with
// its repository, number and state, each a link. The tile's PR chips show only
// "#12 · open"; the section is where a stack of PRs across repos reads whole.
//
// render() runs on every board push while the section is visible, so it builds
// a string and touches the DOM only when that string changed.

const STATES = new Set(['open', 'merged', 'closed']);

/** One card's PRs as HTML. `esc` is the shell's escaper; every value goes through it. */
export function prsHtml(card, esc) {
  const prs = ((card && card.attributes && card.attributes.prs) || []).filter((p) => p && p.url);
  if (!prs.length) return '<p class="muted">No pull requests on this card.</p>';
  const rows = prs.map((pr) => {
    const url = String(pr.url);
    // The URL is the one fact every writer of `prs` records; number and repo are read from it when absent.
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    const num = pr.number !== undefined && pr.number !== null ? String(pr.number) : (m ? m[2] : '');
    const repo = m ? m[1] : '';
    const state = STATES.has(pr.state) ? pr.state : 'open';
    // Only a web link becomes an href: a card attribute can hold anything.
    const href = /^https?:\/\//i.test(url) ? url : '';
    const label = (repo ? repo + ' ' : '') + (num ? '#' + num : 'PR');
    const link = href
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + '</a>'
      : '<span>' + esc(label) + '</span>';
    return '<li class="gh-pr">' + link + ' <span class="prchip pr-' + esc(state) + '">' + esc(state) + '</span></li>';
  });
  return '<ul class="gh-prs">' + rows.join('') + '</ul>';
}

export function activate(ui) {
  const last = new WeakMap(); // el -> the html it holds
  ui.sections.register({
    id: 'prs',
    render(el, card) {
      const html = prsHtml(card, ui.html.esc);
      if (last.get(el) === html) return;
      last.set(el, html);
      el.innerHTML = html;
    },
    dispose(el) { last.delete(el); },
  });
}

export default { activate };
