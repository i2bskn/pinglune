// The conditions that select events: used by list_events and by MCP Events subscriptions.

import { z } from "zod";
import {
  codePointLength,
  LABEL_KEY_PATTERN,
  LABEL_VALUE_MAX_LENGTH,
  MAX_LABELS,
  TYPE_MAX_LENGTH,
  TYPE_PATTERN,
} from "../intake/validation";
import { SOURCE_NAME_MAX_LENGTH } from "../routes/sources";

export const MAX_FILTER_TYPES = 20;
export const MAX_FILTER_SOURCES = 20;

// Every given item must match: types and sources match any of their values, labels match all of their keys.
// An empty array or object is rejected: leave the item out to not filter by it.
export type EventFilter = { types?: string[]; sources?: string[]; labels?: Record<string, string> };

function lengthBetween(min: number, max: number): (value: string) => boolean {
  return (value) => {
    const length = codePointLength(value);
    return length >= min && length <= max;
  };
}

// A shape for z.strictObject, so that tool input schemas can add their own items.
export const eventFilterShape = {
  types: z
    .array(z.string().max(TYPE_MAX_LENGTH).regex(TYPE_PATTERN))
    .min(1)
    .max(MAX_FILTER_TYPES)
    .optional()
    .describe('Event types; an event matches if its type equals any of them. Example: ["alert.observed"]'),
  sources: z
    .array(z.string().refine(lengthBetween(1, SOURCE_NAME_MAX_LENGTH), "1 to 64 characters"))
    .min(1)
    .max(MAX_FILTER_SOURCES)
    .optional()
    .describe('Source names (case-sensitive); an event matches if it was sent by any of them. Example: ["example-app"]'),
  labels: z
    .record(
      z.string().regex(LABEL_KEY_PATTERN),
      z.string().refine(lengthBetween(1, LABEL_VALUE_MAX_LENGTH), "1 to 256 characters"),
    )
    .refine((labels) => {
      const count = Object.keys(labels).length;
      return count >= 1 && count <= MAX_LABELS;
    }, "1 to 16 labels")
    .optional()
    .describe('Labels; an event matches if it has every given key with exactly the given value. Example: {"project": "project-a"}'),
};

// Whether an event matches a filter, with the same meaning as the SQL conditions of list_events
// (src/events/queries.ts). sourceName is the name of the event's source.
export function matchesFilter(
  event: { type: string; sourceName: string; labels: Record<string, string> },
  filter: EventFilter,
): boolean {
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false;
  if (filter.sources !== undefined && !filter.sources.includes(event.sourceName)) return false;
  for (const [key, value] of Object.entries(filter.labels ?? {})) {
    if (!Object.hasOwn(event.labels, key) || event.labels[key] !== value) return false;
  }
  return true;
}
