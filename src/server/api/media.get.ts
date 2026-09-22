import { assertMediaUrl, upstreamHeaders } from '../utils/ifunny'

function safeFilename(value: unknown): string {
  const fallback = 'ifunny-media'
  if (typeof value !== 'string') return fallback
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || fallback
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  if (typeof query.url !== 'string' || query.url.length > 2_048) {
    throw createError({ statusCode: 400, statusMessage: 'A media URL is required.' })
  }

  const mediaUrl = assertMediaUrl(query.url)
  let response: Response
  try {
    response = await fetch(mediaUrl, {
      headers: { ...upstreamHeaders, referer: 'https://ifunny.co/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'The media server did not respond.' })
  }

  if (!response.ok || !response.body) {
    throw createError({ statusCode: 502, statusMessage: `The media server returned ${response.status}.` })
  }

  // Guard against a trusted CDN redirecting the proxy to an arbitrary host.
  assertMediaUrl(response.url)

  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
    throw createError({ statusCode: 502, statusMessage: 'The upstream response was not an image or video.' })
  }

  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${safeFilename(query.filename)}"`,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength) headers['content-length'] = contentLength
  setHeaders(event, headers)

  return sendStream(event, response.body)
})
