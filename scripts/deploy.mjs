// `pnpm run deploy`: applies the D1 migrations, then deploys the Worker.
//
// The Deploy to Cloudflare button and Workers Builds run this script as the deploy command, so it must also
// work on the very first deploy. `wrangler d1 migrations apply` only looks up an existing database, while
// `wrangler deploy` creates the missing D1 database, KV namespace, R2 bucket and queues. So when the database
// does not exist yet, this script deploys first and applies the migrations right after. In that case the new
// Worker runs without tables for a few seconds, which is harmless because nobody uses it yet.
//
// On later deploys the migrations are applied before `wrangler deploy`, so that new code never runs against
// missing tables.
import { spawnSync } from "node:child_process";

const DB_BINDING = "DB";
const MISSING_DATABASE = /Couldn't find (a|an auto-provisioned) D1 DB/;

function wrangler(args, { capture = false } = {}) {
  const result = spawnSync("wrangler", args, {
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function run(args) {
  const { status } = wrangler(args);
  if (status !== 0) {
    process.exit(status ?? 1);
  }
}

const migrate = ["d1", "migrations", "apply", DB_BINDING, "--remote"];
const deploy = ["deploy"];

// `d1 info` fails with the same lookup error as `d1 migrations apply` but never prompts, so its output
// can be captured safely.
const info = wrangler(["d1", "info", DB_BINDING], { capture: true });

if (info.status === 0) {
  run(migrate);
  run(deploy);
} else if (MISSING_DATABASE.test(`${info.stdout}${info.stderr}`)) {
  console.log(`The D1 database for "${DB_BINDING}" does not exist yet: deploying first to create it.`);
  run(deploy);
  run(migrate);
} else {
  process.stdout.write(info.stdout);
  process.stderr.write(info.stderr);
  process.exit(info.status ?? 1);
}
