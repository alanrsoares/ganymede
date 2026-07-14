// Manual GitHub Pages deploy: build, then force-push dist/ to the gh-pages
// branch. Used until the Actions workflow can be pushed (that needs the
// `workflow` OAuth scope). Run: `bun run deploy`.

import { $ } from "bun";

const REPO = "https://github.com/alanrsoares/ganymede.git";

await $`bun run build`;

// dist/ is gitignored in the main repo, so use a throwaway git repo *inside* it:
// force-push just the built output as gh-pages. It contains no workflow files,
// so the push isn't blocked by a missing `workflow` scope.
const stamp = new Date().toISOString();
await $`rm -rf dist/.git`;
await $`git -C dist init -q`;
await $`git -C dist checkout -q -b gh-pages`;
await $`touch dist/.nojekyll`;
await $`git -C dist add -A`;
await $`git -C dist commit -q -m ${`deploy: ${stamp}`}`;
await $`git -C dist push -f ${REPO} gh-pages`;

console.log(`Deployed → https://alanrsoares.github.io/ganymede/ (${stamp})`);
