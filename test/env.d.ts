import type { D1Migration } from "cloudflare:test";
import type { Bindings } from "../src/env";
import type { Intake } from "../src/intake/rpc";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
      // Service Bindings to the Intake entry point of this Worker (vitest.config.ts).
      INTAKE: Service<Intake>;
      INTAKE_NO_PROPS: Service<Intake>;
      INTAKE_MALFORMED: Service<Intake>;
      INTAKE_NOT_STRING: Service<Intake>;
      INTAKE_UNKNOWN: Service<Intake>;
    }
  }
}
