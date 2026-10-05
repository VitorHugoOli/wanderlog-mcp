import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WanderlogValidationError } from "../errors.js";

/**
 * Uploading a local file sends it to Wanderlog, where trip collaborators can
 * see it. Text inside a shared trip could try to talk the model into
 * attaching something private, so uploads are limited to travel-document
 * types, never come from hidden files or folders (~/.ssh, ~/.aws, .env…),
 * and are size-capped.
 */
const UPLOADABLE_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function readUploadableFile(filePath: string): Promise<Buffer> {
  if (!path.isAbsolute(filePath)) {
    throw new WanderlogValidationError(`file path must be absolute (got "${filePath}")`);
  }
  let real: string;
  try {
    real = await realpath(filePath);
  } catch (err) {
    throw new WanderlogValidationError(`Cannot read "${filePath}": ${(err as Error).message}`);
  }
  const ext = path.extname(real).toLowerCase();
  if (!UPLOADABLE_EXTENSIONS.has(ext)) {
    throw new WanderlogValidationError(
      `Only travel documents and photos can be uploaded (${[...UPLOADABLE_EXTENSIONS].join(", ")}); "${path.basename(real)}" is not one.`,
    );
  }
  if (real.split(path.sep).some((segment) => segment.startsWith("."))) {
    throw new WanderlogValidationError(
      `Refusing to upload from a hidden file or folder ("${filePath}").`,
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new WanderlogValidationError(`"${filePath}" is not a file.`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new WanderlogValidationError(
      `"${path.basename(real)}" is ${(info.size / 1048576).toFixed(1)} MB; the limit is 25 MB.`,
    );
  }
  return readFile(real);
}
