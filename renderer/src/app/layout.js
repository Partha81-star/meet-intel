import './globals.css';

export const metadata = {
  title: 'MeetIntel — AI-Powered Meeting Intelligence',
  description:
    'Passive background AI companion that transcribes, detects action items, and surfaces meeting debt in real time.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
