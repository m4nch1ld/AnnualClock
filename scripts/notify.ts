/**
 * Run the notification job from the command line.
 *
 *   npm run notify:dry-run                 # print what would be sent now (no sends, no claims)
 *   npm run notify:run                     # run the job for real
 *   npm run notify:dry-run -- --now=2027-03-01T07:00:00Z   # simulate another moment
 *   npm run notify:dry-run -- --lookback=72               # first-run lookback in hours
 */
import "./load-env";
import { runDefaultNotificationJob } from "../lib/notifications";
import { closePool } from "../lib/db";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

async function main() {
  const dryRun = args["dry-run"] === "true";
  const now = args.now ? new Date(args.now) : new Date();
  const result = await runDefaultNotificationJob({
    dryRun,
    now,
    initialLookbackHours: args.lookback ? Number(args.lookback) : undefined,
  });
  console.log(`\n${dryRun ? "DRY RUN" : "RUN"} ${result.runId}`);
  console.log(`window: ${result.windowStart} → ${result.windowEnd}`);
  if (result.preview) {
    const rows = result.preview.map((p) => ({
      status: p.status,
      kind: p.kind,
      key: p.key,
      channel: p.channel,
      occurrence: p.occurrenceDate,
      title: (p.title ?? "").slice(0, 40),
      recipient: p.recipient,
    }));
    if (rows.length) console.table(rows);
    else console.log("Nothing due in this window.");
    console.log(`planned ${result.planned}: ${result.planned - result.alreadySent} would send, ${result.alreadySent} already sent`);
  } else {
    console.log(
      `planned ${result.planned} · sent ${result.sent} · failed ${result.failed} · skipped ${result.skipped} · already sent ${result.alreadySent} · retried ${result.retried}`,
    );
    console.log("by channel:", result.byChannel);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
