"use server";

import { requireSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { uuid } from "@/lib/validation";

export interface InAppItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export async function listInApp(limit = 10): Promise<InAppItem[]> {
  const s = await requireSession();
  const n = Math.min(100, Math.max(1, Math.floor(limit)));
  return withUser(s.profile.id, (tx) =>
    tx.query<InAppItem>(
      `select id, kind, title, body, link, read_at, created_at from in_app_notifications order by created_at desc limit $1`,
      [n],
    ),
  );
}

export async function markRead(id?: string): Promise<void> {
  const s = await requireSession();
  await withUser(s.profile.id, (tx) =>
    id
      ? tx.query(`update in_app_notifications set read_at = now() where id = $1 and read_at is null`, [uuid.parse(id)])
      : tx.query(`update in_app_notifications set read_at = now() where read_at is null`),
  );
}
