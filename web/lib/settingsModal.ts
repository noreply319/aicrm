"use client";

import { createContext, useContext } from "react";

/**
 * 설정 모달 열기. CrmApp이 값을 제공한다 (프로필 메뉴, "설정 → Google 연동" 안내 링크 등에서 사용).
 * /settings 주소(구글 연동 후 돌아오는 주소)로 들어와도 같은 모달이 열린다.
 */
export const SettingsModalContext = createContext<() => void>(() => {});

export const useOpenSettings = () => useContext(SettingsModalContext);
