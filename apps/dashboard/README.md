This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

коротко как берутся данные

1. Один HTTP-запрос к API StoreLeads (не скрапинг): GET /domain?f:cc=PL&f:p=shopify&sort=rank&page=N&page_size=50. Фильтры по стране и платформе, сортировка по рангу от лучших к худшим.
2. Курсор fetch_cursors хранит offset — сколько строк ответа уже просмотрено. Из него считается страница (offset / 50) и сколько строк выкинуть в её начале (offset % 50).
3. Идём по строкам, пока не наберём batch новых магазинов. Каждая просмотренная строка двигает курсор, но в счёт батча идут только новые: дубликаты и мусор пропускаются.
4. Дубль определяется по нормализованному домену (lowercase, без www/схемы/пути, IDN в punycode) — колонка stores.domain UNIQUE.
5. Новый магазин пишется одной транзакцией: stores + привязка к run + сырой JSON в store_snapshots + приложения + тема.
6. Курсор сохраняется в конце, поэтому следующий запуск продолжает ровно с той строки, где остановился прошлый.
