import CrmApp from "@/components/CrmApp";

/**
 * 파이프라인(/)과 미팅 노트(/meetings)가 공유하는 레이아웃.
 * 레이아웃은 메뉴 이동 시 다시 마운트되지 않으므로 리드·노트 데이터와 Assistant 대화가 유지된다.
 * 화면 전환은 CrmApp이 usePathname으로 처리하고, 각 page는 비어 있다.
 */
export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CrmApp />
      {children}
    </>
  );
}
