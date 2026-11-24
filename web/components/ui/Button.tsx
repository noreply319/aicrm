import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import Icon, { type IconName } from "./Icon";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface StyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 토글 버튼이 켜진 상태 (예: AI Assistant 열림) */
  active?: boolean;
  /** 텍스트 앞 아이콘 */
  icon?: IconName;
  /** 아이콘만 있는 버튼 */
  iconOnly?: boolean;
  disabled?: boolean;
}

/** 버튼 모양 클래스. `<label>` 같은 다른 요소를 버튼처럼 보이게 할 때도 사용 */
export function buttonClass({ variant = "secondary", size = "md", active, iconOnly, disabled }: StyleProps = {}, extra?: string) {
  return cx(
    "btn",
    variant !== "secondary" && `btn-${variant}`,
    size === "sm" && "btn-sm",
    active && "btn-active",
    iconOnly && "icon-btn",
    disabled && "disabled",
    extra
  );
}

type ButtonProps = StyleProps & { children?: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;
type LinkProps = StyleProps & { children?: ReactNode; href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href">;

/**
 * 기본 버튼. href를 주면 `<a>`로 렌더한다 (외부·OAuth 링크용).
 * 앱 내부 화면 이동은 next/link를 쓰고 className에 buttonClass()를 준다.
 */
export default function Button(props: ButtonProps | LinkProps) {
  const { variant, size, active, icon, iconOnly, children, className, ...rest } = props;
  const cls = buttonClass({ variant, size, active, iconOnly, disabled: "href" in props ? props.disabled : undefined }, className);
  const content = (
    <>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </>
  );
  if ("href" in rest && rest.href !== undefined) {
    const { disabled: _d, ...anchor } = rest as LinkProps;
    return <a className={cls} {...anchor}>{content}</a>;
  }
  const { type = "button", ...button } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return <button type={type} className={cls} {...button}>{content}</button>;
}

/** 아이콘 전용 버튼: label은 툴팁·스크린리더 이름 */
export function IconButton({
  icon, label, size = "md", variant = "ghost", ...rest
}: { icon: IconName; label: string; size?: ButtonSize; variant?: ButtonVariant } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <Button variant={variant} size={size} iconOnly title={label} aria-label={label} {...rest}>
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </Button>
  );
}
