import path from "node:path";
import type { AppContext } from "../context.js";
import { WanderlogValidationError } from "../errors.js";
import { getImageDimensions } from "../media/image-dimensions.js";
import { readUploadableFile } from "./uploads.js";

export type JournalMedia = {
  type: "uploaded";
  key: string;
  width: number;
  height: number;
  mediaType: "image";
};

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

/**
 * Upload local photos for a journal stop (flow and media shape from
 * pharkrum@7c38043). Uploads happen before any trip edit, so a failed upload
 * never leaves a half-written stop.
 */
export async function uploadJournalPhotos(
  ctx: AppContext,
  tripKey: string,
  filePaths: string[],
): Promise<JournalMedia[]> {
  if (filePaths.length === 0) return [];
  const files: Array<{
    fileName: string;
    contentType: string;
    bytes: Buffer;
    size: { width: number; height: number };
  }> = [];
  for (const filePath of filePaths) {
    const contentType = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
    if (!contentType) {
      throw new WanderlogValidationError(
        `"${path.basename(filePath)}" is not a photo (png, jpg, gif, webp, heic).`,
      );
    }
    const bytes = await readUploadableFile(filePath);
    files.push({
      fileName: path.basename(filePath),
      contentType,
      bytes,
      size: getImageDimensions(bytes),
    });
  }
  const uploaded = await ctx.rest.uploadMedia(tripKey, files);
  if (uploaded.length !== files.length) {
    throw new WanderlogValidationError(
      `Wanderlog accepted ${uploaded.length} of ${files.length} photos; nothing was added to the journal.`,
    );
  }
  return uploaded.map((u, i) => ({
    type: "uploaded",
    key: u.key,
    width: files[i]!.size.width,
    height: files[i]!.size.height,
    mediaType: "image",
  }));
}
