# Contributing

Issues and pull requests are welcome. Run `npm install`, `npm run build` and `npm test` from the repository root: the
tests are offline and run from recorded fixtures, and `npm run smoke` runs the live read-only checks. A change that
touches the policy, the key check, the signing path or the result shape needs a test that fails without it. Keep the
vocabulary of the README: "agent key", "1-click balance", "hard limits" (the contract) and "policy" (the kit), the
outcomes `filled`, `refused`, `blocked`, `unclear` and `pending`, and no emoji.

The kit is deliberately small. It does not deposit, place auto orders or make Intents deposits, because a
function-call key cannot, and it adds no contract methods and no backend. Please open an issue before a pull request
that would change that. Never commit a key file: `.nearswaps-agent/` and `*.key.json` are ignored for that reason.
