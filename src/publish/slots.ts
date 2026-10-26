/**
 * A page's named slots, filled from front matter.
 *
 * Page-backed types declare slots of their own: an FAQ question has its
 * `answer`, a `short-answer` most readers stop at, and a `related` list. The
 * body of the file is the main slot; the others are the shape fields a file
 * can only declare in front matter. The import door converts a file into one
 * flat document and knows nothing of slots, so a slotted page is written
 * through the page's markdown door instead, where an `## <slot label>` heading
 * becomes that slot (`docFromMarkdownSlots`) — the same form the page's own
 * markdown read prints, so what is compared is what was sent.
 */
export interface Slot {
  key: string;
  label?: string;
  kind?: string;
  render?: string;
  required?: boolean;
  role?: string;
  schemaProperty?: string;
}

const fold = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');

/** The slot a page's body fills: the first prose slot, else the first. */
export function mainSlot(slots: readonly Slot[]): Slot | undefined {
  return slots.find((s) => !s.kind || s.kind === 'prose') ?? slots[0];
}

/** A list slot written as a YAML list reads as a Markdown list. */
function slotText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x ?? '').trim()).filter(Boolean);
    return items.length ? items.map((x) => `- ${x}`).join('\n') : null;
  }
  return null;
}

/**
 * Split front matter into the slots it fills and everything else.
 *
 * A key names a slot when it is the slot's key in any spelling (`short_answer`,
 * `shortAnswer`, `short-answer`). The main slot is the body; front matter may
 * fill it only when the body is empty, and is otherwise reported, because two
 * answers to one question is a mistake somebody wants to hear about.
 */
export function pageSlots(
  data: Record<string, unknown>,
  body: string,
  slots: readonly Slot[],
): { sections: Record<string, string>; rest: Record<string, unknown>; notes: string[] } {
  const sections: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  const notes: string[] = [];
  if (!slots.length) return { sections, rest: { ...data }, notes };
  const byFold = new Map(slots.map((s) => [fold(s.key), s]));
  const main = mainSlot(slots)!;
  for (const [k, v] of Object.entries(data)) {
    const slot = byFold.get(fold(k));
    const text = slot ? slotText(v) : null;
    if (!slot || text === null) {
      rest[k] = v;
      continue;
    }
    if (slot.key === main.key && body.trim()) {
      notes.push(`${k} (the body is the ${main.label ?? main.key})`);
      continue;
    }
    sections[slot.key] = text;
  }
  // Nothing besides the body: an ordinary page, imported as it is.
  if (!Object.keys(sections).length) return { sections, rest, notes };
  if (!sections[main.key] && body.trim()) sections[main.key] = body.trim();
  return { sections, rest, notes };
}

/** The page as the markdown door reads it: `## <label>` per filled slot, in the shape's order. */
export function slottedMarkdown(slots: readonly Slot[], sections: Record<string, string>): string {
  return slots
    .filter((s) => sections[s.key] !== undefined)
    .map((s) => `## ${s.label ?? s.key}\n\n${sections[s.key]!.trim()}\n`)
    .join('\n');
}
