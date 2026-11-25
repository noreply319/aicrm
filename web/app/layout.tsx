import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import { SIDEBAR_AUTO_RAIL_QUERY, SIDEBAR_KEY, THEME_KEY } from "@/lib/constants";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
// 브랜드 워드마크·큰 숫자용 세리프 (디자인 토큰 --font-display)
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-serif" });

export const metadata: Metadata = {
  title: "Pipeline CRM",
  description: "칸반 보드 기반 세일즈 리드 관리",
  // 링크 미리보기 이미지·아이콘은 app/의 opengraph-image.png, icon.svg, favicon.ico, apple-icon.png 파일 규칙으로 자동 연결
  openGraph: {
    type: "website",
    siteName: "Pipeline CRM",
    locale: "ko_KR",
    title: "Pipeline CRM",
    description: "리드부터 수주까지, 세일즈 파이프라인을 한눈에",
  },
  twitter: { card: "summary_large_image" },
};

// Android Chrome: 키보드가 열리면 화면(dvh) 자체가 줄어들게 해 상단은 그대로, 입력창만 키보드 위로 (iOS는 useKeyboardViewport)
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

// 첫 페인트 전에 저장된 테마·메뉴 접힘을 적용해 깜빡임을 막는다.
const themeScript = `try{var d=document.documentElement,t=localStorage.getItem('${THEME_KEY}');if(t)d.dataset.theme=t;if(localStorage.getItem('${SIDEBAR_KEY}')==='collapsed'||matchMedia('${SIDEBAR_AUTO_RAIL_QUERY}').matches)d.classList.add('sb-collapsed');}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${inter.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
