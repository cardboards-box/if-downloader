export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Fetchkit — iFunny Media Downloader',
      meta: [
        { name: 'description', content: 'Download iFunny images and videos in batches.' },
        { name: 'theme-color', content: '#090b12' },
      ],
    },
  },
  nitro: {
    routeRules: {
      '/api/**': { cors: false },
    },
  },
  typescript: {
    typeCheck: true,
  },
})
