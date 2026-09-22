export type MediaType = 'image' | 'video'

export interface ResolvedMedia {
  id: string
  sourceUrl: string
  mediaUrl: string
  thumbnailUrl: string | null
  title: string
  type: MediaType
  filename: string
}

const IFUNNY_HOSTS = new Set(['ifunny.co', 'www.ifunny.co'])
const MEDIA_HOST_PATTERN = /(^|\.)getfn\.io$/i
const VALID_PATH = /^\/(video|picture)\/[^/?#]+/i

const entityMap: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#x27': "'",
}

export function decodeHtml(value: string): string {
  return value.replace(/&(#x?[\da-f]+|\w+);/gi, (entity, key: string) => {
    const normalized = key.toLowerCase()
    if (normalized in entityMap) return entityMap[normalized]
    if (normalized.startsWith('#x')) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16))
    if (normalized.startsWith('#')) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10))
    return entity
  })
}

export function normalizeIfunnyUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'That is not a valid URL.' })
  }

  if (parsed.protocol !== 'https:' || !IFUNNY_HOSTS.has(parsed.hostname.toLowerCase()) || !VALID_PATH.test(parsed.pathname)) {
    throw createError({ statusCode: 400, statusMessage: 'Only iFunny picture and video links are supported.' })
  }

  parsed.hostname = 'ifunny.co'
  parsed.search = ''
  parsed.hash = ''
  return parsed
}

export function assertMediaUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid media URL.' })
  }

  if (parsed.protocol !== 'https:' || !MEDIA_HOST_PATTERN.test(parsed.hostname)) {
    throw createError({ statusCode: 400, statusMessage: 'Untrusted media host.' })
  }
  return parsed
}

function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHtml(match[1])
  }
  return null
}

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHtml(match[1].replace(/\\u002F/g, '/'))
  }
  return null
}

function cleanTitle(title: string | null, id: string): string {
  if (!title) return `iFunny ${id}`
  return decodeHtml(title)
    .replace(/\s+-\s+iFunny$/i, '')
    .replace(/^Video memes\s+\S+\s+by\s+[^:]+(?::.*)?$/i, `iFunny video ${id}`)
    .replace(/\s+/g, ' ')
    .trim()
}

function extensionFromUrl(mediaUrl: string, type: MediaType): string {
  const pathname = new URL(mediaUrl).pathname
  const extension = pathname.match(/\.([a-z\d]{2,5})$/i)?.[1]?.toLowerCase()
  if (extension && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm'].includes(extension)) return extension
  return type === 'video' ? 'mp4' : 'jpg'
}

export function parseIfunnyPage(sourceUrl: URL, html: string): ResolvedMedia {
  const pathType: MediaType = sourceUrl.pathname.startsWith('/video/') ? 'video' : 'image'
  const id = sourceUrl.pathname.split('/').filter(Boolean).at(-1)?.split('-').at(-1) || 'media'

  const videoUrl = firstMatch(html, [
    /<video[^>]+data-src=["']([^"']+)["']/i,
    /"url"\s*:\s*"(https?:\\u002F\\u002F[^"\\]+\.mp4[^"\\]*)"/i,
  ]) || metaContent(html, 'og:video:secure_url') || metaContent(html, 'og:video:url') || metaContent(html, 'twitter:player')

  const imageUrl = firstMatch(html, [
    /<img[^>]+src=["'](https:\/\/img\.getfn\.io\/images\/[^"']+)["'][^>]+class=["'][^"']*IqZk/i,
    /"url"\s*:\s*"(https?:\\u002F\\u002Fimg\.getfn\.io\\u002Fimages\\u002F[^"\\]+)"/i,
  ]) || metaContent(html, 'og:image:secure_url') || metaContent(html, 'og:image') || metaContent(html, 'twitter:image')

  const type: MediaType = videoUrl ? 'video' : pathType
  const mediaUrl = type === 'video' ? videoUrl : imageUrl
  if (!mediaUrl) {
    throw createError({ statusCode: 422, statusMessage: 'No downloadable media was found on this iFunny page.' })
  }
  assertMediaUrl(mediaUrl)

  const title = cleanTitle(metaContent(html, 'og:title'), id)
  const extension = extensionFromUrl(mediaUrl, type)

  return {
    id,
    sourceUrl: sourceUrl.toString(),
    mediaUrl,
    thumbnailUrl: imageUrl,
    title,
    type,
    filename: `ifunny-${id}.${extension}`,
  }
}

export const upstreamHeaders = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
}
