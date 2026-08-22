/** Pure-JS raster header inspection（替代 sharp，适配 pkg 单文件运行时无原生依赖的环境） */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

/** Admission limits applied to a decoded raster's intrinsic dimensions. */
export interface DecodedImageLimits {
  /** Decoded-pixel (width times height) admission limit. */
  maxPixels?: number
  /** Per-side admission limit applied to width and height independently. */
  maxDimension?: number
}

function be16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!
}

function be32(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0
}

function le16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8)
}

function le24(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)
}

function invalid(): AttachmentError {
  return new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
}

/** 解析 PNG/JPEG/WebP/GIF 文件头，返回格式与固有尺寸（不解码像素）。 */
function detect(data: Uint8Array): DetectedImage {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    if (data.length < 24) throw invalid()
    return { mediaType: 'image/png', width: be32(data, 16), height: be32(data, 20) }
  }

  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // JPEG：扫描 SOF 标记（SOF0-3/5-7/9-11/13-15）拿尺寸
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]!
      // 独立标记 / 填充字节
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01 || marker === 0xff) {
        offset += 2
        continue
      }
      if (offset + 4 > data.length) break
      const length = be16(data, offset + 2)
      if (length < 2) break
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
      if (isSof) {
        if (offset + 9 > data.length) throw invalid()
        return { mediaType: 'image/jpeg', height: be16(data, offset + 5), width: be16(data, offset + 7) }
      }
      offset += 2 + length
    }
    throw invalid()
  }

  if (data.length >= 16
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x20) {
      // VP8X：canvas 尺寸为 24-bit LE（offset 24），各减 1
      if (data.length < 30) throw invalid()
      return { mediaType: 'image/webp', width: le24(data, 24) + 1, height: le24(data, 27) + 1 }
    }
    if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x4c) {
      // VP8L：14-bit 宽高（offset 21）
      if (data.length < 25) throw invalid()
      const b0 = data[21]!
      const b1 = data[22]!
      const b2 = data[23]!
      const b3 = data[24]!
      return {
        mediaType: 'image/webp',
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      }
    }
    if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38) {
      // VP8（有损）：宽高为 14-bit LE（offset 26/28）
      if (data.length < 30) throw invalid()
      return {
        mediaType: 'image/webp',
        width: le16(data, 26) & 0x3fff,
        height: le16(data, 28) & 0x3fff,
      }
    }
    throw invalid()
  }

  if (data.length >= 10
    && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
    && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) {
    return { mediaType: 'image/gif', width: le16(data, 6), height: le16(data, 8) }
  }

  throw invalid()
}

/**
 * Parse a supported raster's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  try {
    return detect(data)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/**
 * Run the admission policy for one image: header validation + intrinsic
 * dimension/pixel limits. 原 sharp 实现在此会全量解码校验；纯 JS 版本以
 * 文件头解析代替（四种格式的魔数/尺寸字段都是确定性的）。
 * @param data - complete encoded image bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  try {
    const detected = await probeImage(data)
    if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
