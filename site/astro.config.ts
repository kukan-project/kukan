import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  site: 'https://kukan-project.github.io',
  integrations: [
    starlight({
      title: 'KUKAN',
      head: isProd
        ? [
            {
              tag: 'script',
              content: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
                new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
                j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
                'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
                })(window,document,'script','dataLayer','GTM-NCMB89RM');`,
            },
          ]
        : [],
      defaultLocale: 'ja',
      locales: {
        ja: {
          label: '日本語',
          lang: 'ja',
        },
        en: {
          label: 'English',
          lang: 'en',
        },
      },
      logo: {
        src: './src/assets/logo.svg',
        alt: 'KUKAN',
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/kukan-project/kukan',
        },
      ],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
      customCss: ['./src/styles/global.css'],
      sidebar: [
        {
          label: 'はじめに',
          translations: { en: 'Getting Started' },
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: '利用者ガイド',
          translations: { en: 'User Guide' },
          items: [{ autogenerate: { directory: 'user-guide' } }],
        },
        {
          label: 'データ管理者ガイド',
          translations: { en: 'Data Admin Guide' },
          items: [{ autogenerate: { directory: 'data-admin-guide' } }],
        },
        {
          label: 'システム管理者ガイド',
          translations: { en: 'System Admin Guide' },
          items: [{ autogenerate: { directory: 'system-admin-guide' } }],
        },
        {
          label: 'API リファレンス',
          translations: { en: 'API Reference' },
          items: [{ autogenerate: { directory: 'api' } }],
        },
      ],
    }),
  ],
})
