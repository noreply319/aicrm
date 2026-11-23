import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { THEME_KEY } from "@/lib/constants";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Pipeline CRM",
  description: "칸반 보드 기반 세일즈 리드 관리",
};

// 첫 페인트 전에 저장된 테마를 적용해 깜빡임을 막는다.
const themeScript = `try{var t=localStorage.getItem('${THEME_KEY}');if(t)document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
