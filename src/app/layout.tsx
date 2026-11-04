import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Intel-Agent",
  description: "Personal automated intelligence briefings.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 720, padding: 24 }}>
        {children}
      </body>
    </html>
  );
}
