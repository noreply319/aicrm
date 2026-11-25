"use client";

import { useRef, useState } from "react";
import type { CompanyStats } from "@/lib/company";
import type { BusinessCardDraft, BusinessCardMatch, Company, Contact, ContactInput } from "@/lib/types";
import type { BusinessCards, CardItem } from "@/lib/useBusinessCards";
import CompanyCombobox from "./CompanyCombobox";
import { Alert, Badge, Button, Field, Input } from "./ui";

/** 확인 카드가 화면(CrmApp)에 요청하는 것 */
export interface CardHost {
  companies: Company[];
  companyStats: Record<string, CompanyStats>;
  /** 회사 선택 칸에서 이름만으로 회사 생성 */
  createCompany: (name: string) => Promise<Company>;
  /** 기존 연락처 빈 항목 채우기 */
  updateContact: (id: string, input: ContactInput) => Promise<Contact>;
  /** 저장 후 회사·연락처 목록 다시 불러오기 */
  onSaved: () => void;
  openCompany: (id: string) => void;
  openContact: (id: string) => void;
  /** 리드 모달을 회사·담당자를 채운 채로 연다 */
  newLead: (companyId: string | null, contactId: string) => void;
}

interface Props {
  card: CardItem;
  cards: BusinessCards;
  host: CardHost;
}

const STATUS: Record<CardItem["status"], { label: string; tone: "neutral" | "brand" | "success" | "warning" | "danger" }> = {
  reading: { label: "읽는 중", tone: "neutral" },
  review: { label: "확인", tone: "brand" },
  saving: { label: "저장 중", tone: "neutral" },
  saved: { label: "등록됨", tone: "success" },
  duplicate: { label: "이미 있음", tone: "warning" },
  error: { label: "실패", tone: "danger" },
};

/** 대화 안의 명함 카드: 분석 중 → 확인(수정) → 생성 → 회사·연락처 링크, 중복이면 빈 항목 채우기 */
export default function BusinessCardConfirm({ card, cards, host }: Props) {
  const backRef = useRef<HTMLInputElement>(null);
  const s = STATUS[card.status];
  const title = card.draft?.contact.name || card.draft?.company.name || "명함";

  return (
    <section className={`bcard bcard-${card.status}`} aria-label={`명함: ${title}`}>
      <div className="bcard-head">
        <Badge tone={s.tone}>{s.label}</Badge>
        <strong className="bcard-title">{card.status === "reading" ? "명함을 읽고 있어요…" : title}</strong>
        {card.status !== "saving" && card.status !== "saved" && (
          <Button size="sm" variant="ghost" onClick={() => cards.remove(card.id)}>
            닫기
          </Button>
        )}
      </div>

      <div className="bcard-body">
        <div className="bcard-thumbs">
          {card.previews.map((u, i) => (
            // 사용자가 고른 사진 미리보기 (object URL)
            <img key={u} src={u} alt={i === 0 ? "명함 앞면" : "명함 뒷면"} />
          ))}
        </div>

        <div className="bcard-main">
          {card.status === "error" && (
            <Alert
              tone="danger"
              action={card.images.length > 0 && <Button size="sm" onClick={() => cards.retry(card.id)}>다시 시도</Button>}
            >
              {card.error}
            </Alert>
          )}

          {(card.status === "review" || card.status === "saving") && card.draft && card.match && (
            <CardForm key={card.images.length} card={card} draft={card.draft} match={card.match} cards={cards} host={host} />
          )}

          {card.status === "duplicate" && card.existing && card.draft && (
            <Duplicate card={card} existing={card.existing} draft={card.draft} match={card.match} cards={cards} host={host} />
          )}

          {card.status === "saved" && card.saved && (
            <div className="bcard-done">
              <p>
                {card.existing ? (
                  <>기존 연락처 <b>{card.saved.contact.name}</b>의 빈 항목을 명함 값으로 채웠어요.</>
                ) : (
                  <>
                    연락처 <b>{card.saved.contact.name}</b>
                    {card.saved.company && (
                      <> · 회사 <b>{card.saved.company.name}</b>{card.saved.companyCreated ? " (새로 만듦)" : " (기존 회사)"}</>
                    )}
                    을(를) 등록했어요.
                  </>
                )}
              </p>
              <div className="bcard-actions">
                <Button size="sm" variant="primary" icon="plus" onClick={() => host.newLead(card.saved!.contact.companyId, card.saved!.contact.id)}>
                  이 담당자로 리드 만들기
                </Button>
                <Button size="sm" icon="user" onClick={() => host.openContact(card.saved!.contact.id)}>연락처 보기</Button>
                {card.saved.contact.companyId && (
                  <Button size="sm" icon="building" onClick={() => host.openCompany(card.saved!.contact.companyId!)}>회사 보기</Button>
                )}
              </div>
            </div>
          )}

          {/* 앞면만 읽었을 때: 뒷면을 더해 함께 다시 읽기 */}
          {card.images.length === 1 && (card.status === "review" || card.status === "error") && (
            <>
              <Button size="sm" variant="ghost" icon="camera" onClick={() => backRef.current?.click()}>
                뒷면 추가
              </Button>
              <input
                ref={backRef}
                type="file"
                accept="image/*"
                hidden
                aria-label="명함 뒷면 이미지 선택"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) cards.addBack(card.id, f);
                }}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

type CompanyMode = "existing" | "new" | "none";

/** 확인 단계: 회사(기존 연결 / 새로 만들기 / 없음)와 연락처 값을 고친 뒤 생성 */
function CardForm({ card, draft, match, cards, host }: { card: CardItem; draft: BusinessCardDraft; match: BusinessCardMatch } & Omit<Props, "card">) {
  const [mode, setMode] = useState<CompanyMode>(match.company ? "existing" : draft.company.name ? "new" : "none");
  const [companyId, setCompanyId] = useState<string | null>(match.company?.id ?? null);
  const [company, setCompany] = useState(draft.company);
  const [contact, setContact] = useState(draft.contact);
  const saving = card.status === "saving";

  const setC = (k: keyof typeof company) => (e: React.ChangeEvent<HTMLInputElement>) => setCompany({ ...company, [k]: e.target.value });
  const setP = (k: keyof typeof contact) => (e: React.ChangeEvent<HTMLInputElement>) => setContact({ ...contact, [k]: e.target.value });

  const canSave = Boolean(contact.name.trim()) && (mode !== "existing" || companyId) && (mode !== "new" || company.name.trim());

  const submit = async () => {
    cards.patch(card.id, { draft: { company, contact } });
    const saved = await cards.save(card.id, {
      companyId: mode === "existing" ? companyId : null,
      company: mode === "new" ? company : null,
      contact,
    });
    if (saved) host.onSaved();
  };

  return (
    <form
      className="bcard-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !saving) submit();
      }}
    >
      <fieldset disabled={saving}>
        <legend className="bcard-legend">회사</legend>
        <div className="bcard-modes" role="group" aria-label="회사 연결 방식">
          <Button size="sm" active={mode === "existing"} onClick={() => setMode("existing")}>기존 회사</Button>
          <Button size="sm" active={mode === "new"} onClick={() => setMode("new")}>새 회사</Button>
          <Button size="sm" active={mode === "none"} onClick={() => setMode("none")}>회사 없음</Button>
        </div>
        {mode === "existing" && (
          <>
            {match.company && companyId === match.company.id && (
              <p className="muted">명함의 {match.companyByDomain ? "이메일 도메인" : "회사명"}과 같은 회사를 찾았어요.</p>
            )}
            <CompanyCombobox
              companies={host.companies}
              stats={host.companyStats}
              value={companyId}
              onChange={(c) => setCompanyId(c?.id ?? null)}
              onCreate={host.createCompany}
              leadEmail={contact.email}
            />
          </>
        )}
        {mode === "new" && (
          <div className="form-grid">
            <Field label="회사명" full>
              <Input value={company.name} onChange={setC("name")} maxLength={100} required />
            </Field>
            <Field label="웹사이트">
              <Input value={company.website} onChange={setC("website")} />
            </Field>
            <Field label="이메일 도메인">
              <Input value={company.emailDomain} onChange={setC("emailDomain")} placeholder="acme.co.kr" />
            </Field>
            <Field label="대표 전화">
              <Input value={company.phone} onChange={setC("phone")} />
            </Field>
            <Field label="사업자번호">
              <Input value={company.businessNumber} onChange={setC("businessNumber")} inputMode="numeric" />
            </Field>
            <Field label="주소" full>
              <Input value={company.address} onChange={setC("address")} />
            </Field>
          </div>
        )}
      </fieldset>

      <fieldset disabled={saving}>
        <legend className="bcard-legend">연락처</legend>
        {match.sameName && (
          <Alert tone="warning" action={<Button size="sm" onClick={() => host.openContact(match.sameName!.id)}>보기</Button>}>
            같은 회사에 같은 이름의 연락처가 이미 있어요: {match.sameName.name}
          </Alert>
        )}
        <div className="form-grid">
          <Field label="이름">
            <Input value={contact.name} onChange={setP("name")} maxLength={50} required />
          </Field>
          <Field label="직함">
            <Input value={contact.title} onChange={setP("title")} maxLength={50} />
          </Field>
          <Field label="부서" full>
            <Input value={contact.department} onChange={setP("department")} maxLength={50} />
          </Field>
          <Field label="이메일" full>
            <Input type="email" value={contact.email} onChange={setP("email")} />
          </Field>
          <Field label="휴대폰">
            <Input type="tel" value={contact.mobile} onChange={setP("mobile")} />
          </Field>
          <Field label="유선 전화">
            <Input type="tel" value={contact.officePhone} onChange={setP("officePhone")} />
          </Field>
          {contact.linkedinUrl && (
            <Field label="LinkedIn" full>
              <Input value={contact.linkedinUrl} onChange={setP("linkedinUrl")} />
            </Field>
          )}
        </div>
      </fieldset>

      {card.error && <Alert tone="danger">{card.error}</Alert>}
      <p className="muted">명함 이미지는 AI(OpenAI)로 분석했고 저장하지 않았어요. 값을 확인한 뒤 생성하세요.</p>
      <div className="bcard-actions">
        <Button type="submit" variant="primary" disabled={!canSave || saving}>
          {saving ? "저장 중…" : mode === "new" ? "회사·연락처 생성" : "연락처 생성"}
        </Button>
      </div>
    </form>
  );
}

const FILLABLE = ["department", "title", "mobile", "officePhone", "linkedinUrl"] as const;

/** 같은 이메일 연락처가 이미 있을 때: 열기 또는 비어 있는 항목만 명함 값으로 채우기 (있는 값은 덮어쓰지 않음) */
function Duplicate({
  card, existing, draft, match, cards, host,
}: { card: CardItem; existing: Contact; draft: BusinessCardDraft; match: BusinessCardMatch | null } & Omit<Props, "card">) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fill: Partial<ContactInput> = {};
  for (const k of FILLABLE) if (!existing[k] && draft.contact[k]) fill[k] = draft.contact[k];
  if (!existing.companyId && match?.company) fill.companyId = match.company.id;
  const count = Object.keys(fill).length;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id: _id, createdAt: _c, updatedAt: _u, ...base } = existing;
      const contact = await host.updateContact(existing.id, { ...base, ...fill });
      cards.patch(card.id, { status: "saved", saved: { company: null, companyCreated: false, contact } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bcard-dup">
      <p>
        같은 이메일의 연락처가 이미 있어요: <b>{existing.name}</b>
        {existing.title && ` · ${existing.title}`}
      </p>
      {count > 0 ? (
        <p className="muted">비어 있는 항목 {count}개를 명함 값으로 채울 수 있어요. 이미 있는 값은 바꾸지 않아요.</p>
      ) : (
        <p className="muted">명함으로 채울 빈 항목이 없어요.</p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="bcard-actions">
        {count > 0 && (
          <Button size="sm" variant="primary" disabled={busy} onClick={apply}>
            {busy ? "채우는 중…" : "빈 항목만 채우기"}
          </Button>
        )}
        <Button size="sm" icon="user" onClick={() => host.openContact(existing.id)}>기존 연락처 열기</Button>
      </div>
    </div>
  );
}
