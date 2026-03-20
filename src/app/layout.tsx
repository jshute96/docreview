import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Docreview",
  description: "Track your Google Docs workflow",
  icons: {
    icon: "/docreview.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Hide body until useCachedTitles hook removes this style after populating titles */}
        <style id="hide-until-titles" dangerouslySetInnerHTML={{ __html: `body{visibility:hidden}` }} />
        {/* Fallback: reveal body after 2s if the hook never runs (e.g. JS error) */}
        <script dangerouslySetInnerHTML={{ __html: `setTimeout(function(){var s=document.getElementById("hide-until-titles");if(s)s.remove()},2000)` }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
