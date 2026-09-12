import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QA Thinking Agent',
  description: 'Requirement in. Gaps and questions out. Approved missions on disk.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
