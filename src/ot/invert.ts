import { isDeepStrictEqual } from "node:util";
import type { QuillDelta, TripPlan } from "../types.js";
import { applySingleOp, type Json0Op, type JsonContainer } from "./apply.js";
import { deltaLength, deltaToRuns, type DeltaOp } from "./rich-text.js";

/**
 * Inverse of a json0 op array, computed against the document it is about to
 * be applied to. Components are inverted one at a time on a working copy, so
 * a component that targets something an earlier component created (a note's
 * text right after its insert) sees the right "before" value. Returns null
 * when an op cannot be inverted safely; callers then keep no undo for it.
 */
export function invertOps(before: TripPlan, ops: Json0Op[]): Json0Op[] | null {
  // Never let undo bookkeeping break a write: any surprise just means no undo.
  try {
    // One working copy, components applied in place: cloning the whole trip
    // per component stalled the event loop on large batches.
    const work = structuredClone(before) as unknown as JsonContainer;
    const inverse: Json0Op[] = [];
    for (const op of ops) {
      const inv = invertComponent(work, op);
      if (!inv) return null;
      inverse.unshift(...inv);
    }
    for (const op of inverse) applySingleOp(work, op);
    // Applying the inverse must restore the original exactly.
    return isDeepStrictEqual(work, before) ? inverse : null;
  } catch {
    return null;
  }
}

function valueAt(doc: unknown, path: (string | number)[]): unknown {
  let cur = doc as Record<string | number, unknown> | undefined;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key] as Record<string | number, unknown> | undefined;
  }
  return cur;
}

/** Computes a component's inverse, then applies the component to `doc` in place. */
function invertComponent(doc: JsonContainer, op: Json0Op): Json0Op[] | null {
  const inv = inverseOf(doc, op);
  if (inv) applySingleOp(doc, op);
  return inv;
}

function inverseOf(doc: JsonContainer, op: Json0Op): Json0Op[] | null {
  const { p } = op;
  if (op.t !== undefined) {
    if (op.t !== "rich-text") return null;
    // Restore the field's previous delta wholesale: delete what the op leaves,
    // insert what was there (formatting and embeds included).
    const previous = structuredClone(valueAt(doc, p)) as QuillDelta | undefined;
    if (!previous) return null;
    const probe = { field: structuredClone(previous) } as JsonContainer;
    applySingleOp(probe, { ...op, p: ["field"] });
    const length = deltaLength((probe as { field: QuillDelta }).field);
    const restore: DeltaOp[] = deltaToRuns(previous).map((run) => {
      const insert = run.embed ?? run.text;
      return run.attributes ? { insert, attributes: run.attributes } : { insert };
    });
    return [{ p, t: "rich-text", o: [...(length > 0 ? [{ delete: length }] : []), ...restore] }];
  }
  if ("lm" in op && op.lm !== undefined) {
    const from = p[p.length - 1] as number;
    return [{ p: [...p.slice(0, -1), op.lm], lm: from }];
  }
  if ("na" in op && op.na !== undefined) return [{ p, na: -op.na }];
  if ("si" in op || "sd" in op) {
    const inv: Json0Op = { p };
    if (op.si !== undefined) inv.sd = op.si;
    if (op.sd !== undefined) inv.si = op.sd;
    return [inv];
  }
  if ("li" in op || "ld" in op) {
    const inv: Json0Op = { p };
    if (op.li !== undefined) inv.ld = structuredClone(op.li);
    if (op.ld !== undefined) inv.li = structuredClone(valueAt(doc, p));
    return [inv];
  }
  if ("oi" in op || "od" in op) {
    const inv: Json0Op = { p };
    if ("oi" in op) inv.od = structuredClone(op.oi);
    const existing = valueAt(doc, p);
    if (existing !== undefined) inv.oi = structuredClone(existing);
    return [inv];
  }
  return null;
}
