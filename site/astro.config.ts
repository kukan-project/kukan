import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://kukan-project.github.io',
  integrations: [
    starlight({
      title: 'KUKAN',
      defaultLocale: 'root',
      locales: {
        root: {
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
      customCss: ['./src/styles/global.css'],
      sidebar: [
        {
          label: 'はじめに',
          translations: { en: 'Getting Started' },
          items: [
            {
              label: 'クイックスタート',
              translations: { en: 'Quick Start' },
              slug: 'docs/getting-started',
            },
          ],
        },
        {
          label: '利用者ガイド',
          translations: { en: 'User Guide' },
          items: [
            {
              label: '検索・閲覧',
              translations: { en: 'Search & Browse' },
              slug: 'docs/user-guide',
            },
          ],
        },
        {
          label: 'データ管理者ガイド',
          translations: { en: 'Data Admin Guide' },
          items: [
            {
              label: 'データセット管理',
              translations: { en: 'Dataset Management' },
              slug: 'docs/data-admin-guide',
            },
          ],
        },
        {
          label: 'システム管理者ガイド',
          translations: { en: 'System Admin Guide' },
          items: [
            {
              label: 'デプロイ・運用',
              translations: { en: 'Deployment & Operations' },
              slug: 'docs/system-admin-guide',
            },
          ],
        },
        {
          label: 'API リファレンス',
          translations: { en: 'API Reference' },
          items: [
            {
              label: '概要',
              translations: { en: 'Overview' },
              slug: 'docs/api',
            },
            {
              label: '認証',
              translations: { en: 'Authentication' },
              slug: 'docs/api/authentication',
            },
            {
              label: 'REST API',
              translations: { en: 'REST API' },
              slug: 'docs/api/rest',
            },
            {
              label: 'CKAN 互換 API',
              translations: { en: 'CKAN-Compatible API' },
              slug: 'docs/api/ckan',
            },
          ],
        },
      ],
    }),
  ],
})
