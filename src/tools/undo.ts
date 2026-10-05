import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { clearUndo, submitOp, undoStack } from "./shared.js";

export const undoInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose last change(s) to undo."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("How many of this session's changes to undo, newest first (default 1, max 5)."),
};

export const undoDescription = `
Undoes the most recent change(s) this server made to a trip in this session, by sending the
exact inverse edits (a real revert, unlike a history pop). Refuses when the trip was changed
afterwards by anyone else — in the Wanderlog app or another session — so it never overwrites
someone's work. History lives in memory: it is lost when the server restarts, and trip
deletion, trip creation and file uploads cannot be undone.
`.trim();

type Args = { trip_key: string; steps?: number };

export async function undo(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const wanted = args.steps ?? 1;
    const undone = await submitOp(
      ctx,
      args.trip_key,
      async (entry, submit) => {
        const stack = undoStack(args.trip_key);
        const done: string[] = [];
        while (done.length < wanted && stack.length > 0) {
          const top = stack[stack.length - 1]!;
          if (entry.version !== top.versionAfter) {
            clearUndo(args.trip_key);
            if (done.length > 0) break;
            throw new WanderlogValidationError(
              `"${entry.snapshot.title}" was changed after that edit (in the Wanderlog app or another session), so undoing it could overwrite newer work.`,
              "Make the correction directly instead (e.g. remove or move the item).",
            );
          }
          const before = entry.version;
          for (const batch of top.batches) await submit(batch);
          stack.pop();
          done.push(top.summary);
          // The trip is now back at the state the next entry left it in; only
          // its version number moved. If anything else slipped in, stop trusting the rest.
          const next = stack[stack.length - 1];
          if (entry.version === before + top.batches.length) {
            if (next) next.versionAfter = entry.version;
          } else {
            clearUndo(args.trip_key);
            break;
          }
        }
        return { done, title: entry.snapshot.title };
      },
      { recordUndo: false },
    );
    if (undone.done.length === 0) {
      return {
        content: [{ type: "text", text: `Nothing to undo for "${undone.title}" in this session.` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Undid ${undone.done.length} change(s) in "${undone.title}": ${undone.done.map((d) => `(${d})`).join(", ")}.`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
