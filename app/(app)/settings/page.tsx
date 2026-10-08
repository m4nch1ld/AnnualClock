import { requireSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { ProfileForm, PrefsForm, IcsFeeds } from "./forms";

export const metadata = { title: "My settings" };

export default async function SettingsPage() {
  const session = await requireSession();
  const uid = session.profile.id;
  const { prefs, feeds, clocks } = await withUser(uid, async (tx) => {
    const prefs = await tx.query<{ clock_id: string; enabled: boolean; channels: string[]; subscribe_all: boolean; delivery: "individual" | "digest" }>(
      `select clock_id, enabled, channels, subscribe_all, delivery from notification_prefs where user_id = $1`,
      [uid],
    );
    const feeds = await tx.query<{ id: string; clock_id: string | null; label: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
      `select id, clock_id, label, created_at, last_used_at, revoked_at from ics_tokens where user_id = $1 order by created_at desc`,
      [uid],
    );
    const clocks = await tx.query<{ id: string; name: string }>(`select id, name from clocks where archived_at is null order by position, name`);
    return { prefs, feeds, clocks };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="accent-bar text-2xl">My settings</h1>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Profile & digest</h2>
        <ProfileForm fullName={session.profile.full_name ?? ""} email={session.profile.email} weeklyDigest={session.profile.weekly_digest} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-lg">Notifications per clock</h2>
        <p className="mb-4 text-sm text-muted">
          You always get reminders for activities you own or are assigned to (unless you turn the clock off). Subscribe to get reminders for
          every activity in the clock. Overdue escalations to clock admins are always sent by email.
        </p>
        {session.memberships.length === 0 ? (
          <p className="text-sm text-muted">You are not a member of any clock.</p>
        ) : (
          <div className="space-y-3">
            {session.memberships.map((m) => {
              const p = prefs.find((x) => x.clock_id === m.clock_id);
              return (
                <PrefsForm
                  key={m.clock_id}
                  clockId={m.clock_id}
                  clockName={m.name}
                  color={m.color}
                  initial={p ?? { enabled: true, channels: ["email", "in_app"], subscribe_all: false, delivery: "individual" }}
                />
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-lg">Calendar subscriptions (ICS)</h2>
        <p className="mb-4 text-sm text-muted">
          Subscribe in Outlook (Add calendar → Subscribe from web), Google Calendar (From URL) or Apple Calendar. The link is private: anyone with it
          can read the feed, so revoke it if it leaks. Calendars refresh every few hours.
        </p>
        <IcsFeeds clocks={clocks} feeds={feeds} />
      </Card>
    </div>
  );
}
