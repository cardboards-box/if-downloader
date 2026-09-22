<script setup lang="ts">
type ItemStatus = 'queued' | 'resolving' | 'ready' | 'downloading' | 'done' | 'error'

interface ResolvedResponse {
  id: string
  sourceUrl: string
  title: string
  type: 'image' | 'video'
  filename: string
  thumbnailUrl: string | null
  downloadUrl: string
}

interface QueueItem {
  key: string
  inputUrl: string
  status: ItemStatus
  progress: number
  loaded: number
  total: number
  media?: ResolvedResponse
  error?: string
}

const input = ref('')
const items = ref<QueueItem[]>([])
const isRunning = ref(false)
const isDragging = ref(false)
const controller = shallowRef<AbortController | null>(null)

const exampleLinks = [
  'https://ifunny.co/video/eSeSPsNdD?s=cl',
  'https://ifunny.co/picture/rapper-50-cent-said-that-he-will-reach-out-to-MuCUqL6gD',
]

function extractLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/(?:www\.)?ifunny\.co\/(?:video|picture)\/[^\s<>\])}"']+/gi) || []
  const seen = new Set<string>()
  return matches.reduce<string[]>((result, raw) => {
    try {
      const url = new URL(raw.replace(/[.,;!?]+$/, ''))
      url.hostname = 'ifunny.co'
      url.search = ''
      url.hash = ''
      const clean = url.toString()
      if (!seen.has(clean)) {
        seen.add(clean)
        result.push(clean)
      }
    } catch { /* Ignore malformed matches. */ }
    return result
  }, []).slice(0, 30)
}

const detectedLinks = computed(() => extractLinks(input.value))
const invalidLineCount = computed(() => {
  if (!input.value.trim()) return 0
  const nonEmpty = input.value.split(/\r?\n/).filter(line => line.trim()).length
  return Math.max(0, nonEmpty - detectedLinks.value.length)
})
const completedCount = computed(() => items.value.filter(item => item.status === 'done').length)
const failedCount = computed(() => items.value.filter(item => item.status === 'error').length)
const activeCount = computed(() => items.value.filter(item => ['resolving', 'downloading'].includes(item.status)).length)
const overallProgress = computed(() => {
  if (!items.value.length) return 0
  return Math.round(items.value.reduce((sum, item) => sum + item.progress, 0) / items.value.length)
})
const queueComplete = computed(() => items.value.length > 0 && items.value.every(item => ['done', 'error'].includes(item.status)))

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${decodeURIComponent(url.pathname)}`
  } catch { return value }
}

function statusLabel(item: QueueItem): string {
  if (item.status === 'resolving') return 'Finding media…'
  if (item.status === 'ready') return 'Ready'
  if (item.status === 'downloading') {
    return item.total ? `${formatBytes(item.loaded)} / ${formatBytes(item.total)}` : `${formatBytes(item.loaded)} downloaded`
  }
  if (item.status === 'done') return 'Saved to your device'
  if (item.status === 'error') return item.error || 'Download failed'
  return 'Waiting'
}

function useExamples() {
  input.value = exampleLinks.join('\n')
}

function clearAll() {
  if (isRunning.value) controller.value?.abort()
  input.value = ''
  items.value = []
  isRunning.value = false
}

async function resolveItem(item: QueueItem, signal: AbortSignal) {
  item.status = 'resolving'
  item.progress = 7
  try {
    item.media = await $fetch<ResolvedResponse>('/api/resolve', {
      method: 'POST',
      body: { url: item.inputUrl },
      signal,
    })
    item.status = 'ready'
    item.progress = 12
  } catch (error: any) {
    if (signal.aborted) throw error
    item.status = 'error'
    item.progress = 100
    item.error = error?.data?.statusMessage || error?.statusMessage || 'Could not read this iFunny post.'
  }
}

function triggerSave(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

async function downloadItem(item: QueueItem, signal: AbortSignal) {
  if (!item.media) return
  item.status = 'downloading'
  item.progress = 14
  try {
    const response = await fetch(item.media.downloadUrl, { signal })
    if (!response.ok || !response.body) throw new Error(`Download returned ${response.status}`)

    item.total = Number(response.headers.get('content-length')) || 0
    const reader = response.body.getReader()
    const chunks: BlobPart[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = new Uint8Array(value.byteLength)
      chunk.set(value)
      chunks.push(chunk.buffer)
      item.loaded += value.byteLength
      item.progress = item.total ? Math.max(14, Math.round(item.loaded / item.total * 100)) : Math.min(94, item.progress + 1)
    }

    const contentType = response.headers.get('content-type') || undefined
    triggerSave(new Blob(chunks, { type: contentType }), item.media.filename)
    item.progress = 100
    item.status = 'done'
  } catch (error: any) {
    if (signal.aborted) throw error
    item.status = 'error'
    item.progress = 100
    item.error = error?.message || 'The media download failed.'
  }
}

async function startDownload() {
  const links = detectedLinks.value
  if (!links.length || isRunning.value) return

  items.value = links.map((url, index) => ({
    key: `${Date.now()}-${index}`,
    inputUrl: url,
    status: 'queued',
    progress: 0,
    loaded: 0,
    total: 0,
  }))
  isRunning.value = true
  controller.value = new AbortController()
  const signal = controller.value.signal

  try {
    // Resolve a few pages concurrently without hammering iFunny.
    for (let index = 0; index < items.value.length; index += 3) {
      await Promise.all(items.value.slice(index, index + 3).map(item => resolveItem(item, signal)))
    }
    // Download sequentially so browsers reliably save every file.
    for (const item of items.value) {
      if (item.status === 'ready') await downloadItem(item, signal)
    }
  } catch {
    if (signal.aborted) {
      items.value.forEach((item) => {
        if (!['done', 'error'].includes(item.status)) {
          item.status = 'error'
          item.error = 'Cancelled'
          item.progress = 100
        }
      })
    }
  } finally {
    isRunning.value = false
    controller.value = null
  }
}

async function retryItem(item: QueueItem) {
  if (isRunning.value) return
  isRunning.value = true
  controller.value = new AbortController()
  item.error = undefined
  item.progress = 0
  item.loaded = 0
  item.total = 0
  try {
    await resolveItem(item, controller.value.signal)
    if (item.status === 'ready') await downloadItem(item, controller.value.signal)
  } finally {
    isRunning.value = false
    controller.value = null
  }
}

function cancelDownload() {
  controller.value?.abort()
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  const text = event.dataTransfer?.getData('text/plain')
  if (text) input.value = input.value ? `${input.value.trim()}\n${text}` : text
}

useSeoMeta({
  title: 'Fetchkit — iFunny Media Downloader',
  description: 'Paste iFunny links and download images and videos in one batch.',
})
</script>

<template>
  <div class="app-shell">
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />

    <main class="download-main">
      <section class="workspace" aria-labelledby="downloader-heading">
        <div class="workspace-heading">
          <div>
            <div>
              <h2 id="downloader-heading">Drop your links</h2>
              <p>One link per line, or paste a whole messy message.</p>
            </div>
          </div>
          <button v-if="input || items.length" class="text-button" type="button" :disabled="isRunning" @click="clearAll">Clear all</button>
        </div>

        <div class="input-wrap" :class="{ dragging: isDragging }" @dragover.prevent="isDragging = true" @dragleave="isDragging = false" @drop.prevent="onDrop">
          <textarea v-model="input" :disabled="isRunning" spellcheck="false" aria-label="iFunny links" placeholder="https://ifunny.co/video/...&#10;https://ifunny.co/picture/..."></textarea>
          <div class="input-footer">
            <div class="detected-count" :class="{ active: detectedLinks.length }">
              <span class="pulse-dot" />
              <strong>{{ detectedLinks.length }}</strong> valid {{ detectedLinks.length === 1 ? 'link' : 'links' }} detected
              <span v-if="invalidLineCount" class="ignored">· {{ invalidLineCount }} ignored</span>
            </div>
            <button v-if="!input" class="example-button" type="button" @click="useExamples">Try sample links</button>
            <span v-else class="limit">{{ detectedLinks.length }} / 30</span>
          </div>
        </div>

        <button class="download-button" type="button" :disabled="!detectedLinks.length || isRunning" @click="startDownload">
          <svg v-if="!isRunning" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span v-else class="spinner" />
          {{ isRunning ? `Working on ${activeCount || 1}…` : `Download ${detectedLinks.length || ''} ${detectedLinks.length === 1 ? 'file' : 'files'}` }}
          <span v-if="!isRunning" class="button-arrow">→</span>
        </button>
        <p class="helper"><svg viewBox="0 0 18 18"><path d="M9 1.8 3.2 4v4.3c0 3.6 2.5 6.8 5.8 7.9 3.3-1.1 5.8-4.3 5.8-7.9V4L9 1.8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m6.7 8.8 1.5 1.5 3.2-3.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>Files pass securely through our server and are never stored.</p>
      </section>

      <Transition name="queue">
        <section v-if="items.length" class="queue-panel" aria-live="polite">
          <div class="queue-header">
            <div>
              <div>
                <h2>{{ queueComplete ? 'Batch complete' : 'Downloading your batch' }}</h2>
                <p v-if="queueComplete">{{ completedCount }} saved<span v-if="failedCount"> · {{ failedCount }} failed</span></p>
                <p v-else>{{ completedCount }} of {{ items.length }} files saved</p>
              </div>
            </div>
            <div class="overall-number">{{ overallProgress }}%</div>
          </div>
          <div class="overall-track"><div :style="{ width: `${overallProgress}%` }" /></div>

          <div class="queue-list">
            <article v-for="item in items" :key="item.key" class="queue-item" :class="`is-${item.status}`">
              <div class="thumb">
                <img v-if="item.media?.thumbnailUrl" :src="item.media.thumbnailUrl" alt="" loading="lazy">
                <svg v-else-if="item.media?.type === 'video'" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" fill="currentColor"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4V5Zm0 11 5-5 4 4 2-2 5 5" stroke="currentColor" stroke-width="1.6"/></svg>
                <span v-if="item.media" class="type-chip">{{ item.media.type }}</span>
              </div>
              <div class="item-info">
                <div class="item-title">{{ item.media?.title || shortUrl(item.inputUrl) }}</div>
                <div class="item-status">
                  <span class="status-icon">
                    <svg v-if="item.status === 'done'" viewBox="0 0 20 20"><path d="m5 10 3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
                    <svg v-else-if="item.status === 'error'" viewBox="0 0 20 20"><path d="m6 6 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
                    <span v-else-if="['resolving','downloading'].includes(item.status)" class="mini-spinner" />
                    <span v-else class="waiting-dot" />
                  </span>
                  {{ statusLabel(item) }}
                </div>
                <div class="item-track"><div :style="{ width: `${item.progress}%` }" /></div>
              </div>
              <div class="item-action">
                <strong>{{ item.progress }}%</strong>
                <button v-if="item.status === 'error' && item.error !== 'Cancelled'" type="button" :disabled="isRunning" @click="retryItem(item)">Retry</button>
              </div>
            </article>
          </div>

          <button v-if="isRunning" class="cancel-button" type="button" @click="cancelDownload">Cancel batch</button>
          <button v-else-if="queueComplete" class="new-batch-button" type="button" @click="clearAll">Start a new batch</button>
        </section>
      </Transition>
    </main>
  </div>
</template>
