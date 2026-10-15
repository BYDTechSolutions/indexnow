// Submit a few changed pages with the API.
// Prints the request body only; pass --send to really submit.
//
//   node examples/submit-changed.mjs https://example.com /pricing /blog/new-post
//   node examples/submit-changed.mjs https://example.com /pricing --send
import { findKey, submit, verifyKey } from '@bydtech/indexnow';

const args = process.argv.slice(2);
const send = args.includes('--send');
const [site, ...paths] = args.filter((a) => a !== '--send');
if (!site || !paths.length) {
  console.error('Usage: node examples/submit-changed.mjs <site> <path...> [--send]');
  process.exit(2);
}

const found = await findKey('public');
if (!found) {
  console.error('No key file in public/. Run: npx indexnow key');
  process.exit(2);
}

if (send) {
  const check = await verifyKey({ site, key: found.key });
  if (!check.ok) {
    console.error(check.message);
    process.exit(1);
  }
}

const result = await submit({ site, key: found.key, urls: paths, dryRun: !send });
if (!send) {
  console.log(JSON.stringify(result.payloads, null, 2));
  console.log('Dry run: nothing was sent. Add --send to submit.');
} else {
  for (const batch of result.batches) console.log(`HTTP ${batch.status}: ${batch.message}`);
}
process.exitCode = result.ok ? 0 : 1;
