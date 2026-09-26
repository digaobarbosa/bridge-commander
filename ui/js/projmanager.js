// The config screen's projects section: the registry a card's `repo`
// attribute has to name, and the facts that decide whether a start off one will
// work — how many live cards point at it, where it pushes, and the branch a
// fresh worktree starts detached from.
//
// Showing only. Registering a project clones a repo and removing one deletes a
// checkout that may hold uncommitted work; neither belongs behind a click.
import { api } from './api.js';
import { listSection, paintCards } from './listpanel.js';
import { projectView } from './panelviews.js';

let listEl;
/** Hand the section its list element: {list}. */
export function initProjects(els) { listEl = els.list; }

let items = null; // [{name, path, cards, remote, branch, missing}] — last answer

// `reload` is what the tab passes on the way in, so entering reads disk afresh
// while the renders that follow — one per board event — repaint what is here.
// Nothing runs while another tab is up: opening config for labels runs no git.
export const renderProjects = listSection({
  load: async () => { items = (await api.projects(true)).projects || []; },
  paint: () => paintCards(listEl, items.map(projectView), () => {}, 'no projects'),
  fail: (e) => { listEl.textContent = '⚠ ' + e.message; },
});
