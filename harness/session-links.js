'use strict';

// Stable conversation providers are independent of a particular harness profile.
const PROVIDERS = {
  codex: { cli: 'codex resume', app: { label: 'Codex', url: 'codex://threads/{id}' } },
  claude: { cli: 'claude --resume' },
};
const SESSION_PROVIDERS = Object.keys(PROVIDERS);
function providerInfo(provider) { return PROVIDERS[provider] || null; }
module.exports = { SESSION_PROVIDERS, providerInfo };
