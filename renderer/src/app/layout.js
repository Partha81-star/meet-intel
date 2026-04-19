import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata = {
  title: 'MeetIntel — AI-Powered Meeting Intelligence',
  description:
    'Passive background AI companion that transcribes, detects action items, and surfaces meeting debt in real time.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-surface text-white antialiased min-h-screen">{children}</body>
    </html>
  );
}
