/** Zod schemas for all server-side input. */
import { z } from "zod";
import { isISODate } from "./dates";
import { ACTIVITY_STATUSES, ACTIVITY_TYPES, CLOCK_ROLES } from "./domain";
import { normalizeRRule } from "./recurrence";

export const isoDate = z.string().refine(isISODate, "Invalid date");
export const uuid = z.uuid();
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .optional()
  .transform((v) => v || null);

export const linkSchema = z.object({
  label: z.string().trim().max(120).optional(),
  url: z
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "Only http(s) links"),
});

export const activityInput = z
  .object({
    id: uuid.optional(),
    clock_id: uuid,
    ring_id: uuid,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable().optional().transform((v) => v || null),
    type: z.enum(ACTIVITY_TYPES),
    start_date: isoDate,
    end_date: isoDate.nullable().optional().transform((v) => v || null),
    all_day: z.boolean().default(true),
    start_time: time,
    end_time: time,
    rrule: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .transform((v, ctx) => {
        if (!v) return null;
        const n = normalizeRRule(v);
        if (!n) {
          ctx.addIssue({ code: "custom", message: "Invalid recurrence rule" });
          return z.NEVER;
        }
        return n;
      }),
    owner_id: uuid.nullable().optional().transform((v) => v ?? null),
    assignee_ids: z.array(uuid).max(50).default([]),
    status: z.enum(ACTIVITY_STATUSES).default("planned"),
    predecessor_id: uuid.nullable().optional().transform((v) => v ?? null),
    reminder_offsets: z.array(z.number().int().min(0).max(365)).max(10).nullable().optional().transform((v) => v ?? null),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    links: z.array(linkSchema).max(20).default([]),
    /** for edits of a recurring series opened from an occurrence */
    scope: z.enum(["all", "future"]).default("all"),
    occurrence_date: isoDate.optional(),
  })
  .refine((a) => !a.end_date || a.end_date >= a.start_date, { message: "End date must be on or after start date", path: ["end_date"] })
  .refine((a) => a.type !== "period" || !!a.end_date, { message: "A period needs an end date", path: ["end_date"] })
  .refine((a) => a.predecessor_id !== a.id || !a.id, { message: "An activity cannot follow itself", path: ["predecessor_id"] });

export type ActivityInput = z.input<typeof activityInput>;

export const moveInput = z.object({
  activity_id: uuid,
  occurrence_date: isoDate,
  new_start: isoDate,
  new_end: isoDate.nullable(),
  scope: z.enum(["all", "future"]).default("all"),
});

export const occurrenceStatusInput = z.object({
  activity_id: uuid,
  occurrence_date: isoDate,
  status: z.enum(ACTIVITY_STATUSES),
});

export const snoozeInput = z.object({
  activity_id: uuid,
  occurrence_date: isoDate,
  until: isoDate,
});

export const roleSchema = z.enum(CLOCK_ROLES);
export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const offsetsSchema = z.array(z.number().int().min(0).max(365)).max(10);
