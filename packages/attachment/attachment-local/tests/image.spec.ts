import { describe, expect, it } from 'vitest'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { detectImage, probeImage } from '../src/image.ts'

// 固定小图 fixture（3x2），用纯 JS 头解析即可得到格式与尺寸
const PNG_3X2 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAE0lEQVR4nGNkZGL+zwAFTAxIAAAWxgEJsxy/+gAAAABJRU5ErkJggg==',
  'base64',
))
const JPEG_3X2 = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
  'base64',
))
const WEBP_3X2 = Uint8Array.from(Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoDAAIAAUAmJaQAA3AA/v0gUAA=',
  'base64',
))
const GIF_3X2 = Uint8Array.from(Buffer.from(
  'R0lGODdhAwACAIEAAAECAwAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7',
  'base64',
))

const FIXTURES: Array<[Uint8Array, ImageMediaType]> = [
  [PNG_3X2, 'image/png'],
  [JPEG_3X2, 'image/jpeg'],
  [WEBP_3X2, 'image/webp'],
  [GIF_3X2, 'image/gif'],
]

describe('raster header inspection', () => {
  it('reads every supported format and its intrinsic dimensions', async () => {
    for (const [data, mediaType] of FIXTURES) {
      await expect(detectImage(data))
        .resolves.toEqual({ mediaType, width: 3, height: 2 })
    }
  })

  it('rejects excess decoded pixels before storing', async () => {
    await expect(detectImage(PNG_3X2, { maxPixels: 5 }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
  })

  it('rejects a side above the per-side limit and accepts a side exactly at it', async () => {
    await expect(detectImage(PNG_3X2, { maxDimension: 2 }))
      .rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    await expect(detectImage(PNG_3X2, { maxDimension: 3 }))
      .resolves.toEqual({ mediaType: 'image/png', width: 3, height: 2 })
  })

  it('rejects malformed bytes, unsupported formats, and headers cut short', async () => {
    await expect(detectImage(Uint8Array.of(1, 2, 3)))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    // BMP 是不支持的格式
    await expect(detectImage(Uint8Array.of(0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    // 截断到 IHDR 尺寸字段之前（< 24 字节）应判为无效
    const truncated = PNG_3X2.subarray(0, 20)
    await expect(detectImage(truncated)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('probes malformed bytes and unsupported formats into the same stable error', async () => {
    await expect(probeImage(Uint8Array.of(1, 2, 3)))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(probeImage(Uint8Array.of(0x42, 0x4d, 0x00, 0x00, 0x00, 0x00)))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })
})
