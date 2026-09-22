import { normalizeIfunnyUrl, parseIfunnyPage, upstreamHeaders } from '../utils/ifunny'

interface ResolveBody {
  url?: unknown
}

export default defineEventHandler(async (event) => {
  const body = await readBody<ResolveBody>(event)
  if (typeof body?.url !== 'string' || body.url.length > 2_048) {
    throw createError({ statusCode: 400, statusMessage: 'A valid iFunny URL is required.' })
  }

  const sourceUrl = normalizeIfunnyUrl(body.url)

  let response: Response
  try {
    response = await fetch(sourceUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'iFunny could not be reached. Try again in a moment.' })
  }

  if (!response.ok) {
    throw createError({ statusCode: 502, statusMessage: `iFunny returned ${response.status} for this link.` })
  }

  // Do not follow an unexpected redirect away from iFunny.
  normalizeIfunnyUrl(response.url)

  const html = await response.text()
  if (html.length > 3_000_000) {
    throw createError({ statusCode: 502, statusMessage: 'The iFunny response was unexpectedly large.' })
  }

  const media = parseIfunnyPage(sourceUrl, html)
  return {
    id: media.id,
    sourceUrl: media.sourceUrl,
    title: media.title,
    type: media.type,
    filename: media.filename,
    thumbnailUrl: media.thumbnailUrl,
    downloadUrl: `/api/media?url=${encodeURIComponent(media.mediaUrl)}&filename=${encodeURIComponent(media.filename)}`,
  }
})
