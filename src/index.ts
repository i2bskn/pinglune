import { clock, loadConfig } from "@i2bskn/workers-app-core";
import app from "./app";
import { core } from "./core";
import { handleQueue } from "./deliveries/consumer";
import type { Bindings } from "./env";
import { handleEmail } from "./intake/email";
import { runDailyMaintenance } from "./maintenance/daily";

export type { AppType } from "./app";
// The Service Bindings entry point of the intake (entrypoint: "Intake").
export { Intake } from "./intake/rpc";

export default {
  // OAuth and /mcp through OAuthProvider on origins that can host them, everything else through the app. The OAuth
  // paths are /mcp, /mcp/*, /oauth/*, /.well-known/* and /authorize: keep them in run_worker_first in wrangler.jsonc.
  fetch: core.fetch(app),

  // The delivery queue and its dead letter queue (src/deliveries/consumer.ts).
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    await handleQueue(batch, env);
  },

  // The email intake (src/intake/email.ts), from the catch-all rule of Email Routing.
  async email(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
    await handleEmail(message, env);
  },

  // The daily cron (src/maintenance/daily.ts).
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const result = loadConfig(env);
    if (!result.ok) {
      console.error("invalid configuration", { invalid: result.invalid });
      return;
    }
    ctx.waitUntil(
      runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, queue: env.DELIVERY_QUEUE, now: clock.now() }),
    );
  },
} satisfies ExportedHandler<Bindings>;
