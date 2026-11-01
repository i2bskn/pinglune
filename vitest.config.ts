import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Fixed source IDs for the Service Bindings tests: props are set here, so the tests insert sources with
// these IDs (test/intake-rpc.test.ts repeats them).
const RPC_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
const RPC_UNKNOWN_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8W";

// Bindings to this Worker's Intake entry point, as a caller's wrangler configuration would set them. The
// plugin points a service named after the Worker ("pinglune") at the Worker under test.
function intakeBinding(props?: Record<string, unknown>) {
  return { name: "pinglune", entrypoint: "Intake", ...(props === undefined ? {} : { props }) };
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("drizzle/migrations");
  return {
    test: {
      projects: [
        // Worker tests, run in workerd.
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  AUTH_MODE: "password",
                  JWT_SECRET: "test-secret-test-secret-test-secret-0123",
                },
                // The producer sends to a queue that has no consumer, so that the consumer of wrangler.jsonc never
                // runs in the background during tests. Consumer tests call the queue handler directly.
                queueProducers: { DELIVERY_QUEUE: { queueName: "pinglune-deliveries-test" } },
                serviceBindings: {
                  INTAKE: intakeBinding({ source_id: RPC_SOURCE_ID }),
                  INTAKE_NO_PROPS: intakeBinding(),
                  INTAKE_MALFORMED: intakeBinding({ source_id: "src_not-a-ulid" }),
                  INTAKE_NOT_STRING: intakeBinding({ source_id: 42 }),
                  INTAKE_UNKNOWN: intakeBinding({ source_id: RPC_UNKNOWN_SOURCE_ID }),
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.test.ts"],
            setupFiles: ["./test/setup.ts"],
            testTimeout: 30000,
          },
        },
        // Client tests that need no browser, run in Node.
        {
          test: {
            name: "client",
            include: ["client/**/*.test.{ts,tsx}"],
            environment: "node",
          },
        },
      ],
    },
  };
});
