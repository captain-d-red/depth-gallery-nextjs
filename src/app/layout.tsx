import type { Metadata, Viewport } from 'next';
import { uiFont } from '@/lib/fonts';
import './globals.css';

const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Long Take',
  description:
    'One continuous shot through seventy-two films from 2010 to 2025, each poster lighting the air around it.',
  openGraph: {
    title: 'Long Take',
    description: 'One continuous shot through seventy-two films, each poster lighting the air around it.',
    type: 'website',
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: '#09080b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={uiFont.variable}>
      <body>{children}</body>
    </html>
  );
}
