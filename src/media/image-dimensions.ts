/**
 * Minimal image-dimension extractor for PNG and JPEG.
 *
 * Wanderlog's journal stores width/height on every media entry alongside the
 * storage key. To match the UI's persisted shape we need to compute the
 * dimensions client-side before submitting. Rather than pull in a dependency
 * (image-size, sharp, etc.) we parse the headers directly — both formats are
 * well-defined and small.
 *
 * Other formats (WebP, GIF, HEIC) fall back to {width: 0, height: 0} so the
 * upload still works, but the journal layout may not be ideal until viewed.
 */
export type Dimensions = { width: number; height: number };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG);
}

function readPngDimensions(buf: Buffer): Dimensions {
  // PNG IHDR chunk begins at offset 8 (signature) + 8 (length+type) = 16.
  // 4 bytes width, 4 bytes height, both big-endian unsigned 32-bit.
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * JPEG dimensions live inside the first SOF (Start Of Frame) marker. Markers
 * are 0xFF followed by a non-zero byte; SOF markers are 0xC0..0xCF excluding
 * 0xC4 (DHT) and 0xC8 (reserved) and 0xCC (DAC). For our purposes we accept
 * any 0xC0..0xC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF.
 */
function readJpegDimensions(buf: Buffer): Dimensions {
  let off = 2; // skip SOI (0xFFD8)
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return { width: 0, height: 0 };
    const marker = buf[off + 1]!;
    // Standalone markers (no segment data): D0..D7 (RSTn), 01.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    // End of image.
    if (marker === 0xd9 || marker === 0xda) return { width: 0, height: 0 };
    // SOF marker we can read: 0xC0..0xCF excluding 0xC4/0xC8/0xCC.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // After marker (2 bytes): segment length (2 bytes), precision (1), height (2), width (2)
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return { width, height };
    }
    // Non-SOF marker — skip segment.
    const segLen = buf.readUInt16BE(off + 2);
    off += 2 + segLen;
  }
  return { width: 0, height: 0 };
}

export function getImageDimensions(bytes: Buffer): Dimensions {
  if (isPng(bytes)) return readPngDimensions(bytes);
  if (isJpeg(bytes)) return readJpegDimensions(bytes);
  return { width: 0, height: 0 };
}
