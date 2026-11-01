// `pnpm run deploy`: creates the missing D1 databases and R2 buckets in the requested location, applies the D1
// migrations, then deploys the Worker.
//
// The Deploy to Cloudflare button and Workers Builds run this script as the deploy command, so it must also
// work on the very first deploy. `wrangler d1 migrations apply` only looks up an existing database, while
// `wrangler deploy` creates the missing D1 databases, KV namespaces, R2 buckets and queues. So when a database
// does not exist yet, this script deploys first and applies the migrations right after. In that case the new
// Worker runs without tables for a few seconds, which is harmless because nobody uses it yet.
//
// On later deploys the migrations are applied before `wrangler deploy`, so that new code never runs against
// missing tables.
//
// `wrangler deploy` creates D1 databases and R2 buckets without a location, so they end up near the build
// environment. When the LOCATION_HINT environment variable is set (a Workers Builds build variable), this script
// creates the missing ones in that location first, and `wrangler deploy` then connects to them by name. The
// location of an existing database or bucket cannot be changed, so existing ones are left as they are.
//
// The bindings are read from the Wrangler configuration (top level only, not `env.*`), so this script does not
// depend on the names used by this project.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { unstable_readConfig } from "wrangler";

const LOCATIONS = ["weur", "eeur", "apac", "oc", "wnam", "enam"];
const MISSING_DATABASE = /Couldn't find (a|an auto-provisioned) D1 DB/;
const MISSING_BUCKET = "[code: 10006]";
// The default of `migrations_dir` in wrangler.
const DEFAULT_MIGRATIONS_DIR = "./migrations";

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

// Prints the captured output of a failed wrangler command and exits with its status.
function fail(result) {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const location = (process.env.LOCATION_HINT ?? "").trim().toLowerCase() || undefined;
if (location !== undefined && !LOCATIONS.includes(location)) {
  console.error(`Invalid LOCATION_HINT "${process.env.LOCATION_HINT}": expected one of ${LOCATIONS.join(", ")}.`);
  process.exit(1);
}

const config = unstable_readConfig({});
const configDir = config.configPath ? path.dirname(config.configPath) : process.cwd();
const databases = config.d1_databases ?? [];
const buckets = config.r2_buckets ?? [];

// Whether each D1 database exists, by binding.
const databaseExists = new Map();
for (const db of databases) {
  if (!db.database_name && !db.database_id) {
    // `d1 info` fails with a different error for a binding without a name or an ID, and such a database
    // can only be created by `wrangler deploy`.
    databaseExists.set(db.binding, false);
    continue;
  }
  // `d1 info` fails with the same lookup error as `d1 migrations apply` but never prompts, so its output
  // can be captured safely.
  const info = wrangler(["d1", "info", db.binding], { capture: true });
  if (info.status === 0) {
    databaseExists.set(db.binding, true);
  } else if (MISSING_DATABASE.test(output(info))) {
    databaseExists.set(db.binding, false);
  } else {
    fail(info);
  }
}

if (location === undefined) {
  console.log("LOCATION_HINT is not set: wrangler deploy creates the missing resources near the build environment.");
} else {
  // Failures stop the deploy: LOCATION_HINT is an explicit request, so creating the resources elsewhere
  // without notice would be worse than failing.
  // --no-update-config keeps wrangler from offering to add another binding to the configuration when run locally.
  for (const db of databases) {
    if (databaseExists.get(db.binding)) {
      console.log(`The D1 database for "${db.binding}" already exists: leaving it as is.`);
    } else if (!db.database_name) {
      console.log(
        `The D1 database for "${db.binding}" has no database_name, so its location cannot be specified: leaving it to wrangler deploy.`,
      );
    } else if (db.database_id) {
      console.log(
        `The D1 database for "${db.binding}" has a database_id, so it is not created here: leaving it to wrangler deploy.`,
      );
    } else {
      console.log(`Creating D1 database "${db.database_name}" in ${location}.`);
      run(["d1", "create", db.database_name, "--location", location, "--no-update-config"]);
      databaseExists.set(db.binding, true);
    }
  }

  for (const bucket of buckets) {
    if (!bucket.bucket_name || bucket.jurisdiction) {
      const reason = bucket.jurisdiction ? "has a jurisdiction" : "has no bucket_name";
      console.log(
        `The R2 bucket for "${bucket.binding}" ${reason}, so its location cannot be specified: leaving it to wrangler deploy.`,
      );
      continue;
    }
    const info = wrangler(["r2", "bucket", "info", bucket.bucket_name], { capture: true });
    if (info.status === 0) {
      console.log(`The R2 bucket "${bucket.bucket_name}" already exists: leaving it as is.`);
      continue;
    }
    if (!output(info).includes(MISSING_BUCKET)) {
      fail(info);
    }
    console.log(`Creating R2 bucket "${bucket.bucket_name}" in ${location}.`);
    run(["r2", "bucket", "create", bucket.bucket_name, "--location", location, "--no-update-config"]);

    // The location hint only applies to the first bucket ever created with a name, so check where it ended up.
    const created = wrangler(["r2", "bucket", "info", bucket.bucket_name], { capture: true });
    const actual = created.status === 0 ? /^\s*location:\s*(\S+)/m.exec(output(created))?.[1] : undefined;
    console.log(`The R2 bucket "${bucket.bucket_name}" is located in ${actual ?? "(unknown)"}.`);
    if (actual?.toLowerCase() !== location) {
      console.warn(
        `Warning: the R2 bucket "${bucket.bucket_name}" was requested in ${location} but is located in ${actual ?? "(unknown)"}. ` +
          "The location hint may have been ignored because a bucket with the same name existed before.",
      );
    }
  }
}

// `d1 migrations apply` fails when the migrations directory does not exist.
const migrated = databases.filter((db) => {
  const dir = path.resolve(configDir, db.migrations_dir ?? DEFAULT_MIGRATIONS_DIR);
  if (existsSync(dir)) {
    return true;
  }
  console.log(`The D1 database for "${db.binding}" has no migrations directory: skipping its migrations.`);
  return false;
});

function migrate() {
  for (const db of migrated) {
    console.log(`Applying the migrations of the D1 database for "${db.binding}".`);
    run(["d1", "migrations", "apply", db.binding, "--remote"]);
  }
}

function deploy() {
  console.log("Deploying the Worker.");
  run(["deploy"]);
}

const missing = migrated.filter((db) => !databaseExists.get(db.binding));
if (missing.length === 0) {
  migrate();
  deploy();
} else {
  for (const db of missing) {
    console.log(`The D1 database for "${db.binding}" does not exist yet: deploying first to create it.`);
  }
  deploy();
  migrate();
}
